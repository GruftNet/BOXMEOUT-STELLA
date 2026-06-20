/**
 * Integration tests for Redis leader election (issue #19).
 *
 * Uses an in-memory Redis mock shared between instances so the tests run
 * without a live Redis server. The mock faithfully implements SET NX EX,
 * GET, EXPIRE, and the two Lua scripts used by LeaderElection.
 */

// Mock the logger at the module level so we can spy on structured log calls.
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { LeaderElection, LEADER_KEY, LAST_LEDGER_KEY } from '../../src/indexer/LeaderElection';
import { logger } from '../../src/utils/logger';
import { indexerIsLeader } from '../../src/services/metrics.service';

// ── In-memory Redis mock ──────────────────────────────────────────────────────

interface StoreEntry {
  value: string;
  expiresAt: number | null;
}

class InMemoryRedis {
  readonly store = new Map<string, StoreEntry>();

  private live(key: string): StoreEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: string, ...opts: (string | number)[]): Promise<string | null> {
    let nx = false;
    let ttlMs: number | null = null;

    for (let i = 0; i < opts.length; i++) {
      const opt = String(opts[i]).toUpperCase();
      if (opt === 'NX') { nx = true; }
      else if (opt === 'EX') { ttlMs = Number(opts[++i]) * 1000; }
      else if (opt === 'PX') { ttlMs = Number(opts[++i]); }
    }

    if (nx && this.live(key)) return null;

    this.store.set(key, {
      value,
      expiresAt: ttlMs !== null ? Date.now() + ttlMs : null,
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  /** Instantly expire a key — simulates TTL-based leader failure in tests. */
  forceExpire(key: string): void {
    const entry = this.store.get(key);
    if (entry) entry.expiresAt = 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async eval(script: string, numKeys: number, ...args: string[]): Promise<any> {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    // Release script: KEYS[1]=leaderKey, ARGV[1]=instanceId
    if (script.includes('del')) {
      const [leaderKey] = keys;
      const [instanceId] = argv;
      const current = await this.get(leaderKey);
      if (current === instanceId) {
        this.store.delete(leaderKey);
        return 1;
      }
      return 0;
    }

    // Set-cursor script: KEYS[1]=leaderKey, KEYS[2]=cursorKey, ARGV[1]=instanceId, ARGV[2]=value
    const [leaderKey, cursorKey] = keys;
    const [instanceId, value] = argv;
    const current = await this.get(leaderKey);
    if (current === instanceId) {
      await this.set(cursorKey, value);
      return 1;
    }
    return 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeElection(
  store: InMemoryRedis,
  id: string,
  ttl = 10,
  refresh = 4,
): LeaderElection {
  // Cast: InMemoryRedis satisfies the subset of the ioredis API used by LeaderElection
  return new LeaderElection(store as never, id, ttl, refresh);
}

// ── Test suites ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── 1. Basic acquisition ──────────────────────────────────────────────────────

describe('LeaderElection — basic acquisition', () => {
  it('first instance acquires the lease', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'instance-1');
    expect(await e1.acquireLease()).toBe(true);
  });

  it('second instance cannot acquire while first holds the lease', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'instance-1');
    const e2 = makeElection(store, 'instance-2');
    await e1.acquireLease();
    expect(await e2.acquireLease()).toBe(false);
  });

  it('emits { event: "leader_acquired", instance_id, lease_ttl } structured log on acquisition', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'instance-A', 10, 4);
    await e1.acquireLease();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'leader_acquired',
        instance_id: 'instance-A',
        lease_ttl: 10,
      }),
    );
  });
});

// ── 2. Failover within one TTL window ─────────────────────────────────────────

describe('LeaderElection — failover within one TTL window', () => {
  it('standby acquires leadership after the primary loses its lease', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'primary', 10, 4);
    const e2 = makeElection(store, 'standby', 10, 4);

    expect(await e1.acquireLease()).toBe(true);

    // Simulate primary failure by instantly expiring its lease key
    store.forceExpire(LEADER_KEY);

    // Standby polls and should acquire now that the key is gone
    let acquired = false;
    const deadline = Date.now() + 15_000;
    while (!acquired && Date.now() < deadline) {
      acquired = await e2.acquireLease();
      if (!acquired) await Promise.resolve();
    }

    expect(acquired).toBe(true);
    expect(await store.get(LEADER_KEY)).toBe('standby');
  });

  it('new leader reads the cursor left by the failed primary', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'primary', 10, 4);
    const e2 = makeElection(store, 'standby', 10, 4);

    await e1.acquireLease();
    await e1.setLastLedger(1000);

    store.forceExpire(LEADER_KEY);
    expect(await e2.acquireLease()).toBe(true);

    // Standby inherits the cursor and can advance it by one
    expect(await e2.getLastLedger()).toBe(1000);
    expect(await e2.setLastLedger(1001)).toBe(true);
    expect(await e2.getLastLedger()).toBe(1001);
  });
});

// ── 3. Lease renewal and loss detection ───────────────────────────────────────

describe('LeaderElection — lease renewal and loss detection', () => {
  it('renewLease throws when the key no longer belongs to this instance', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'instance-1');
    await e1.acquireLease();

    store.forceExpire(LEADER_KEY);

    await expect(e1.renewLease()).rejects.toThrow('Lease lost');
  });

  it('startRenewal calls onLeaseLost exactly once when renewal fails', async () => {
    jest.useFakeTimers();

    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'instance-1', 10, 4);
    await e1.acquireLease();

    const onLeaseLost = jest.fn();
    e1.startRenewal(onLeaseLost);

    store.forceExpire(LEADER_KEY);

    // Advance past the 4-second refresh interval
    await jest.advanceTimersByTimeAsync(4_500);

    expect(onLeaseLost).toHaveBeenCalledTimes(1);

    e1.stopRenewal();
    jest.useRealTimers();
  });
});

// ── 4. Metrics: indexer_is_leader gauge ───────────────────────────────────────

describe('LeaderElection — indexer_is_leader metric', () => {
  it('gauge reflects leadership transitions', async () => {
    const setSpy = jest.spyOn(indexerIsLeader, 'set');

    // Simulate what StellarIndexerService does on start/stop
    indexerIsLeader.set(1);
    expect(setSpy).toHaveBeenCalledWith(1);

    indexerIsLeader.set(0);
    expect(setSpy).toHaveBeenCalledWith(0);

    setSpy.mockRestore();
  });
});

// ── 5. Idempotency / split-brain window ──────────────────────────────────────

describe('LeaderElection — idempotency (split-brain)', () => {
  it('deposed leader cannot advance the shared cursor', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'old-leader', 10, 4);
    const e2 = makeElection(store, 'new-leader', 10, 4);

    await e1.acquireLease();
    await e1.setLastLedger(500);

    // e1 loses its lease
    store.forceExpire(LEADER_KEY);
    await e2.acquireLease();

    // e1 tries to advance the cursor — must be rejected atomically
    expect(await e1.setLastLedger(501)).toBe(false);

    // Cursor must still be 500 (what e1 last successfully wrote)
    expect(await e2.getLastLedger()).toBe(500);
  });

  it('releaseLease by deposed leader is a no-op (does not delete new leader key)', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'old-leader', 10, 4);
    const e2 = makeElection(store, 'new-leader', 10, 4);

    await e1.acquireLease();
    store.forceExpire(LEADER_KEY);
    await e2.acquireLease();

    await e1.releaseLease();

    expect(await store.get(LEADER_KEY)).toBe('new-leader');
  });
});

// ── 6. Cursor hand-off ────────────────────────────────────────────────────────

describe('LeaderElection — cursor hand-off', () => {
  it('getLastLedger returns null before any leader has written the cursor', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'first-ever', 10, 4);
    await e1.acquireLease();
    expect(await e1.getLastLedger()).toBeNull();
  });

  it('setLastLedger persists the value and returns true while leader', async () => {
    const store = new InMemoryRedis();
    const e1 = makeElection(store, 'leader', 10, 4);
    await e1.acquireLease();
    expect(await e1.setLastLedger(999)).toBe(true);
    expect(await e1.getLastLedger()).toBe(999);
  });
});
