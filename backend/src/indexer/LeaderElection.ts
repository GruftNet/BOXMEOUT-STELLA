import type { Redis } from 'ioredis';
import { logger } from '../utils/logger';

export const LEADER_KEY = 'indexer:leader';
export const LAST_LEDGER_KEY = 'indexer:last_ledger';

// Atomically delete the leader key only if this instance owns it
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

// Atomically set the last_ledger cursor only while this instance is still leader.
// Prevents a deposed leader from clobbering the new leader's cursor.
const SET_CURSOR_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("set", KEYS[2], ARGV[2])
  return 1
else
  return 0
end`;

export class LeaderElection {
  private renewTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly redisClient: Redis,
    readonly instanceId: string,
    readonly leaseTtlSecs: number,
    readonly leaseRefreshSecs: number,
  ) {}

  /**
   * Try to acquire the distributed leader lease.
   * Uses SET NX EX so only one instance can hold the key at a time.
   * Logs a structured event on success.
   */
  async acquireLease(): Promise<boolean> {
    const result = await this.redisClient.set(
      LEADER_KEY,
      this.instanceId,
      'NX',
      'EX',
      this.leaseTtlSecs,
    );
    if (result === 'OK') {
      logger.info({
        event: 'leader_acquired',
        instance_id: this.instanceId,
        lease_ttl: this.leaseTtlSecs,
      });
      return true;
    }
    return false;
  }

  /**
   * Refresh the lease TTL. Throws if the key no longer belongs to this instance,
   * signalling that leadership has been lost.
   */
  async renewLease(): Promise<void> {
    const current = await this.redisClient.get(LEADER_KEY);
    if (current !== this.instanceId) {
      throw new Error(`Lease lost: leader key owned by ${current ?? 'nobody'}`);
    }
    await this.redisClient.expire(LEADER_KEY, this.leaseTtlSecs);
  }

  /**
   * Voluntarily release the leader lease via an atomic Lua script so that
   * a standby can acquire it immediately instead of waiting for TTL expiry.
   */
  async releaseLease(): Promise<void> {
    await this.redisClient.eval(RELEASE_SCRIPT, 1, LEADER_KEY, this.instanceId);
    logger.info({ event: 'leader_released', instance_id: this.instanceId });
  }

  /** Read the shared ledger cursor. Returns null when no leader has written one yet. */
  async getLastLedger(): Promise<number | null> {
    const val = await this.redisClient.get(LAST_LEDGER_KEY);
    return val !== null ? parseInt(val, 10) : null;
  }

  /**
   * Write the shared ledger cursor atomically.
   * The Lua script guarantees this instance is still the leader at write time,
   * preventing a split-brain scenario where a slow ex-leader clobbers the cursor.
   * Returns true when the write succeeded (i.e. this instance is still leader).
   */
  async setLastLedger(ledger: number): Promise<boolean> {
    const result = await this.redisClient.eval(
      SET_CURSOR_SCRIPT,
      2,
      LEADER_KEY,
      LAST_LEDGER_KEY,
      this.instanceId,
      String(ledger),
    );
    return result === 1;
  }

  /**
   * Start a periodic lease-renewal loop using setInterval.
   * If renewal fails (lease expired or stolen), `onLeaseLost` is called exactly once.
   */
  startRenewal(onLeaseLost: () => void): void {
    this.renewTimer = setInterval(async () => {
      try {
        await this.renewLease();
      } catch (err) {
        logger.warn({ event: 'lease_lost', instance_id: this.instanceId, err });
        this.stopRenewal();
        onLeaseLost();
      }
    }, this.leaseRefreshSecs * 1000);
  }

  stopRenewal(): void {
    if (this.renewTimer !== undefined) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }
}
