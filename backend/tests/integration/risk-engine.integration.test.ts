/**
 * Integration tests for the RiskEngine.
 *
 * Strategy: mock all external I/O (Postgres pool, StellarService, Sentry, email)
 * so the tests run without infrastructure, then drive the engine via the same
 * internal BetPlaced bus that production uses.
 *
 * jest.resetAllMocks() is called in beforeEach so that mockResolvedValueOnce
 * queues from prior tests never bleed into later ones.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ── Mock: Postgres pool ────────────────────────────────────────────────────
const mockQuery = jest.fn<() => Promise<unknown>>();

jest.mock('../../src/config/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// ── Mock: StellarService (invokeContract) ─────────────────────────────────
const mockInvokeContract = jest.fn<() => Promise<string>>();

jest.mock('../../src/services/StellarService', () => ({
  invokeContract: (...args: unknown[]) => mockInvokeContract(...args),
}));

// ── Mock: Sentry ───────────────────────────────────────────────────────────
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

// ── Mock: email service ────────────────────────────────────────────────────
const mockSendEmail = jest.fn<() => Promise<void>>();

jest.mock('../../src/services/email.service', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

// ── Import SUT after mocks are in place ───────────────────────────────────
import { RiskEngine } from '../../src/services/RiskEngine';
import { emitBetPlaced } from '../../src/websocket/realtime';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Flush two rounds of setImmediate callbacks + microtasks.
 * Round 1: handleBetPlaced runs (fired by emitBetPlaced handler).
 * Round 2: lockMarketOnChain runs (fired inside processAssessment).
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  await Promise.resolve();
}

// Market IDs — use a numeric string so BigInt(market_id) succeeds in lockMarketOnChain.
const MARKET_ID = '10001';
const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function criticalMarketRow() {
  return {
    market_id: MARKET_ID,
    contract_address: CONTRACT,
    fighter_a: 'Ali',
    fighter_b: 'Frazier',
    status: 'open',
    pool_a: '950',  // ratio = 950/1000 = 0.95 — triggers lock with CRITICAL=0.95
    pool_b: '50',
    total_pool: '1000',
  };
}

function warnMarketRow() {
  return {
    ...criticalMarketRow(),
    pool_a: '850',  // ratio = 850/1000 = 0.85 — triggers warn with MAX=0.80
    pool_b: '150',
    total_pool: '1000',
  };
}

// ── Query sequence documentation ───────────────────────────────────────────
//
// handleBetPlaced:
//   Q1  SELECT market WHERE market_id = $1
//
// processAssessment → checkPlatformExposure:
//   Q2  SELECT COALESCE(SUM(total_pool), 0) FROM markets WHERE status = 'open'
//       If exposure < limit → returns early (no further queries from this branch)
//
// processAssessment → action = 'warn':
//   Q3  SELECT getUnresolvedBreaker(market_id, 'warn')
//   Q4  INSERT circuit_breaker_events  (recordBreaker)
//
// processAssessment → action = 'lock' | 'cap':
//   Q3  SELECT getUnresolvedBreaker(market_id, action)
//   Q4  UPDATE markets SET status = 'locked'
//   Q5  INSERT circuit_breaker_events  (recordBreaker)
//   then setImmediate → lockMarketOnChain → invokeContract (not a pool.query)

// ── Test suite ─────────────────────────────────────────────────────────────

describe('RiskEngine integration', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    // resetAllMocks clears mockResolvedValueOnce queues so prior-test leftovers
    // don't bleed into the next test.
    jest.resetAllMocks();

    engine = new RiskEngine();

    process.env.MAX_IMBALANCE_RATIO = '0.80';
    process.env.CRITICAL_IMBALANCE_RATIO = '0.95';
    process.env.MAX_MARKET_POOL_XLM = '100000';
    process.env.MAX_PLATFORM_EXPOSURE_XLM = '500000';
    process.env.ADMIN_EMAIL = 'admin@boxmeout.app';

    mockInvokeContract.mockResolvedValue('tx-hash-abc');
    mockSendEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    engine.stop();
  });

  // ── 1. Critical-threshold path ─────────────────────────────────────────
  // Queries: Q1 market, Q2 platform SUM, Q3 getUnresolvedBreaker('lock'), Q4 UPDATE, Q5 INSERT

  it('auto-locks a market when BetPlaced pushes it past the critical threshold', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [criticalMarketRow()] })          // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })               // Q2 platform SUM (0 → early return)
      .mockResolvedValueOnce({ rows: [] })                              // Q3 getUnresolvedBreaker('lock') → none
      .mockResolvedValueOnce({ rows: [{}] })                           // Q4 UPDATE status='locked'
      .mockResolvedValueOnce({ rows: [{ id: 1, market_id: MARKET_ID }] }); // Q5 INSERT breaker

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync();

    // DB must be updated to 'locked'
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("status = 'locked'"),
    );
    expect(updateCall).toBeDefined();

    // A circuit_breaker_events row must be inserted
    const insertCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('circuit_breaker_events'),
    );
    expect(insertCall).toBeDefined();

    // Sentry must be called with level 'fatal'
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('AUTO-LOCK'),
      expect.objectContaining({ level: 'fatal' }),
    );
  });

  // ── 2. invokeContract called with correct args ─────────────────────────
  // Same 5-query path, plus a second flushAsync round so lockMarketOnChain fires.

  it('calls invokeContract(lock_market) for the correct contract address', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [criticalMarketRow()] }) // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })      // Q2
      .mockResolvedValueOnce({ rows: [] })                     // Q3
      .mockResolvedValueOnce({ rows: [{}] })                  // Q4
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });          // Q5

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync(); // first round: handleBetPlaced + second setImmediate (lockMarketOnChain)

    expect(mockInvokeContract).toHaveBeenCalledWith(
      CONTRACT,
      'lock_market',
      expect.any(Array),
    );
  });

  // ── 3. Warning path ────────────────────────────────────────────────────
  // Queries: Q1 market, Q2 platform SUM, Q3 getUnresolvedBreaker('warn'), Q4 INSERT breaker

  it('emits a Sentry warning (not fatal) when market is in the warn zone', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [warnMarketRow()] })   // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })    // Q2
      .mockResolvedValueOnce({ rows: [] })                   // Q3 getUnresolvedBreaker('warn') → none
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });        // Q4 INSERT breaker

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync();

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('warning'),
      expect.objectContaining({ level: 'warning' }),
    );
    // Must NOT update market status to locked
    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("status = 'locked'"),
    );
    expect(updateCall).toBeUndefined();
    expect(mockInvokeContract).not.toHaveBeenCalled();
  });

  // ── 4. Idempotency — lock ───────────────────────────────────────────────
  // Queries: Q1 market, Q2 platform SUM, Q3 getUnresolvedBreaker('lock') → existing → early return

  it('does not lock a market a second time when an unresolved lock breaker exists', async () => {
    const existingLock = {
      id: 5, market_id: MARKET_ID, trigger_type: 'lock',
      imbalance_ratio: '0.950000', total_pool_xlm: '0.0001000',
      triggered_at: new Date(), resolved_at: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [criticalMarketRow()] })   // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })        // Q2
      .mockResolvedValueOnce({ rows: [existingLock] });          // Q3 → existing → skip

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync();

    const updateCall = (mockQuery.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes("status = 'locked'"),
    );
    expect(updateCall).toBeUndefined();
    expect(mockInvokeContract).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // ── 5. Idempotency — warn ──────────────────────────────────────────────
  // Queries: Q1 market, Q2 platform SUM, Q3 getUnresolvedBreaker('warn') → existing → early return

  it('does not emit a second warning when an unresolved warn breaker exists', async () => {
    const existingWarn = {
      id: 3, market_id: MARKET_ID, trigger_type: 'warn',
      imbalance_ratio: '0.850000', total_pool_xlm: '0.0001000',
      triggered_at: new Date(), resolved_at: null,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [warnMarketRow()] })     // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })      // Q2
      .mockResolvedValueOnce({ rows: [existingWarn] });        // Q3 → existing → skip

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // ── 6. Non-open market is skipped ─────────────────────────────────────
  // Q1 only — locked market causes early return immediately

  it('skips evaluation when the market is already locked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...criticalMarketRow(), status: 'locked' }] });

    engine.start();
    emitBetPlaced(MARKET_ID);
    await flushAsync();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // ── 7. Admin exposure endpoint — correct imbalance_ratio ─────────────
  // No running engine; getExposureReport is called directly.

  it('getExposureReport returns correct imbalance_ratio for a seeded market', async () => {
    const openMarket = {
      market_id: 'market-exp-001',
      contract_address: CONTRACT,
      fighter_a: 'Ali',
      fighter_b: 'Frazier',
      status: 'open',
      pool_a: '7000000',   // 0.7 XLM
      pool_b: '3000000',   // 0.3 XLM
      total_pool: '10000000',
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [openMarket] })  // SELECT open markets
      .mockResolvedValueOnce({ rows: [] });            // getRecentBreakers

    const report = await engine.getExposureReport();

    expect(report.markets).toHaveLength(1);
    const m = report.markets[0];
    expect(m.market_id).toBe('market-exp-001');
    expect(m.pool_a_xlm).toBeCloseTo(0.7, 6);
    expect(m.pool_b_xlm).toBeCloseTo(0.3, 6);
    // max(0.7, 0.3) / 1.0 = 0.7
    expect(m.imbalance_ratio).toBeCloseTo(0.7, 6);
    expect(report.platform_total_exposure_xlm).toBeCloseTo(1.0, 6);
    expect(report.circuit_breaker_events).toHaveLength(0);
  });

  // ── 8. Engine lifecycle ─────────────────────────────────────────────────

  it('stop() prevents further evaluations after shutdown', async () => {
    engine.start();
    engine.stop();

    emitBetPlaced(MARKET_ID);
    await flushAsync();

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('start() is idempotent — calling it twice registers the handler only once', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [criticalMarketRow()] }) // Q1
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })      // Q2
      .mockResolvedValueOnce({ rows: [] })                     // Q3
      .mockResolvedValueOnce({ rows: [{}] })                  // Q4
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });          // Q5

    engine.start();
    engine.start(); // no-op

    emitBetPlaced(MARKET_ID);
    await flushAsync();

    // Exactly one SELECT market call
    const selectCalls = (mockQuery.mock.calls as unknown[][]).filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).startsWith('SELECT') &&
        (args[0] as string).includes('FROM markets WHERE market_id'),
    );
    expect(selectCalls).toHaveLength(1);
  });
});
