/**
 * Tests for StellarIndexer's startup gap detection and ledger replay
 * (detectAndReplayGap / replayLedgerRange).
 *
 * Strategy: mock all external I/O (Postgres pool, the Stellar RPC server,
 * Sentry, cache invalidation) so the tests run without infrastructure,
 * mirroring the approach used by risk-engine.integration.test.ts.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock: Postgres pool ────────────────────────────────────────────────────
// Tracks tx_hash uniqueness so ON CONFLICT (tx_hash) DO NOTHING behaves like
// a real Postgres unique constraint, and tracks the latest checkpoint value.
let seenTxHashes = new Set<string>();
let checkpointValue: number | null = null;

const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('SELECT last_processed_ledger')) {
    return {
      rows: checkpointValue != null ? [{ last_processed_ledger: checkpointValue }] : [],
      rowCount: checkpointValue != null ? 1 : 0,
    };
  }
  if (sql.includes('INSERT INTO indexer_checkpoints')) {
    checkpointValue = params[0] as number;
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO blockchain_events') && sql.includes('DO NOTHING')) {
    const txHash = params[5] as string;
    if (seenTxHashes.has(txHash)) {
      return { rows: [], rowCount: 0 };
    }
    seenTxHashes.add(txHash);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

jest.mock('../../src/config/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...(args as [string, unknown[]?])) },
}));

// ── Mock: Sentry ───────────────────────────────────────────────────────────
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

// ── Mock: cache invalidation ────────────────────────────────────────────────
const mockCacheDeletePattern = jest.fn(async () => {});
jest.mock('../../src/services/cache.service', () => ({
  cacheDeletePattern: (...args: unknown[]) => mockCacheDeletePattern(...args),
}));

// ── Mock: logger (use the repo's manual mock under src/utils/__mocks__) ────
jest.mock('../../src/utils/logger');

// ── Mock: Stellar RPC server (getEvents / getLatestLedger) ─────────────────
// jest.mock factories are hoisted, so the shared mock fns are exposed on
// `global` and reached at call time rather than closed over directly.
type RpcMock = {
  getEvents: ReturnType<typeof jest.fn<() => Promise<unknown>>>;
  getLatestLedger: ReturnType<typeof jest.fn<() => Promise<unknown>>>;
};

function getGlobalRpcMock(): RpcMock {
  return (global as unknown as { __rpcMock: RpcMock }).__rpcMock;
}

const rpcMock: RpcMock = {
  getEvents: jest.fn<() => Promise<unknown>>(),
  getLatestLedger: jest.fn<() => Promise<unknown>>(),
};
(global as unknown as { __rpcMock: RpcMock }).__rpcMock = rpcMock;

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as Record<string, unknown>;
  return {
    ...actual,
    rpc: {
      ...(actual.rpc as Record<string, unknown>),
      Server: jest.fn().mockImplementation(() => ({
        getEvents: (...a: unknown[]) => getGlobalRpcMock().getEvents(...a),
        getLatestLedger: (...a: unknown[]) => getGlobalRpcMock().getLatestLedger(...a),
      })),
    },
  };
});

import { xdr } from '@stellar/stellar-sdk';
import { detectAndReplayGap, replayLedgerRange } from '../../src/indexer/StellarIndexer';
import { logger } from '../../src/utils/logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a mock RPC `market_locked` event for the given ledger/market/tx hash. */
function mockMarketLockedEvent(ledger: number, marketId: string, txHash: string) {
  return {
    contractId: 'CFACTORYMOCK',
    topic: [xdr.ScVal.scvSymbol('market_locked'), xdr.ScVal.scvString(marketId)],
    value: xdr.ScVal.scvU32(0),
    ledger,
    ledgerClosedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    txHash,
  };
}

/** Wires getEvents to return one market_locked event per ledger in [from, to]. */
function stubEventsForRange(from: number, to: number, marketId: string, txPrefix: string) {
  rpcMock.getEvents.mockImplementation(async (...args: unknown[]) => {
    const { startLedger: seq } = args[0] as { startLedger: number };
    if (seq < from || seq > to) return { events: [] };
    return { events: [mockMarketLockedEvent(seq, marketId, `${txPrefix}-${seq}`)] };
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  seenTxHashes = new Set<string>();
  checkpointValue = null;
  mockQuery.mockClear();
  mockCaptureMessage.mockClear();
  mockCacheDeletePattern.mockClear();
  rpcMock.getEvents.mockReset();
  rpcMock.getLatestLedger.mockReset();
  (logger.info as jest.Mock).mockClear();
  delete process.env.INDEXER_REPLAY_BATCH_SIZE;
  delete process.env.INDEXER_MAX_REPLAY_LEDGERS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('detectAndReplayGap / replayLedgerRange', () => {
  it('replays a 100-ledger gap and advances the checkpoint after the batch commits', async () => {
    checkpointValue = 1000;
    rpcMock.getLatestLedger.mockResolvedValue({ sequence: 1100 });
    // Single batch so the test doesn't pay the real 1s/batch rate limit.
    process.env.INDEXER_REPLAY_BATCH_SIZE = '100';
    stubEventsForRange(1001, 1100, 'mkt-a', 'tx');

    const result = await detectAndReplayGap();

    expect(result.gap_size).toBe(100);
    expect(result.replayed_events).toBe(100);
    expect(result.skipped_duplicates).toBe(0);
    expect(checkpointValue).toBe(1100);
    expect(mockCacheDeletePattern).toHaveBeenCalledWith('market:mkt-a*');
    expect(mockCacheDeletePattern).toHaveBeenCalledWith('markets:*');

    // Structured replay summary logged at INFO level after completion.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        gap_size: 100,
        replayed_events: 100,
        skipped_duplicates: 0,
        duration_ms: expect.any(Number),
      }),
      '[Indexer] Replay summary',
    );
  });

  it('is idempotent — replaying the same range twice does not double blockchain_events', async () => {
    process.env.INDEXER_REPLAY_BATCH_SIZE = '10';
    stubEventsForRange(2001, 2005, 'mkt-b', 'tx-dup');

    const first = await replayLedgerRange(2001, 2005);
    expect(first.replayed_events).toBe(5);
    expect(first.skipped_duplicates).toBe(0);

    const second = await replayLedgerRange(2001, 2005);
    expect(second.replayed_events).toBe(0);
    expect(second.skipped_duplicates).toBe(5);

    expect(seenTxHashes.size).toBe(5);
  });

  it('emits a Sentry warning and skips replay when the gap exceeds INDEXER_MAX_REPLAY_LEDGERS', async () => {
    checkpointValue = 3000;
    rpcMock.getLatestLedger.mockResolvedValue({ sequence: 3000 + 15000 });

    const result = await detectAndReplayGap();

    expect(result.gap_size).toBe(15000);
    expect(result.replayed_events).toBe(0);
    expect(result.skipped_duplicates).toBe(0);
    expect(rpcMock.getEvents).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('Gap of 15000'),
      { level: 'warning' },
    );
    // Checkpoint jumps straight to the current ledger instead of replaying.
    expect(checkpointValue).toBe(18000);
  });

  it('reports no gap when the checkpoint already matches the current ledger', async () => {
    checkpointValue = 5000;
    rpcMock.getLatestLedger.mockResolvedValue({ sequence: 5000 });

    const result = await detectAndReplayGap();

    expect(result).toEqual({ gap_size: 0, replayed_events: 0, skipped_duplicates: 0, duration_ms: 0 });
    expect(rpcMock.getEvents).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
