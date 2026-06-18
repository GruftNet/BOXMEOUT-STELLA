import { describe, it, expect, beforeEach } from '@jest/globals';
import { RiskEngine } from '../../src/services/RiskEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMarket(pool_a: number, pool_b: number) {
  return { pool_a: String(pool_a), pool_b: String(pool_b) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RiskEngine.evaluateMarketRisk()', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine();
    // Set deterministic thresholds — read at evaluation time from process.env.
    process.env.MAX_IMBALANCE_RATIO = '0.80';
    process.env.CRITICAL_IMBALANCE_RATIO = '0.95';
    process.env.MAX_MARKET_POOL_XLM = '100000';
  });

  // ── Imbalance: critical → lock ──────────────────────────────────────────
  it('returns action=lock when pool_a=950, pool_b=50 (ratio 0.95 ≥ CRITICAL)', () => {
    const result = engine.evaluateMarketRisk(makeMarket(950, 50));

    expect(result.imbalance_ratio).toBeCloseTo(0.95, 5);
    expect(result.absolute_breach).toBe(false);
    expect(result.action).toBe('lock');
  });

  // ── Imbalance: warning zone ─────────────────────────────────────────────
  it('returns action=warn when pool_a=850, pool_b=150 (ratio 0.85 ≥ MAX but < CRITICAL)', () => {
    const result = engine.evaluateMarketRisk(makeMarket(850, 150));

    expect(result.imbalance_ratio).toBeCloseTo(0.85, 5);
    expect(result.absolute_breach).toBe(false);
    expect(result.action).toBe('warn');
  });

  // ── Balanced pools → no action ──────────────────────────────────────────
  it('returns action=none for balanced pools (500 / 500, ratio 0.5)', () => {
    const result = engine.evaluateMarketRisk(makeMarket(500, 500));

    expect(result.imbalance_ratio).toBeCloseTo(0.5, 5);
    expect(result.absolute_breach).toBe(false);
    expect(result.action).toBe('none');
  });

  // ── Balanced but below warning threshold ────────────────────────────────
  it('returns action=none when ratio=0.79 (just below MAX_IMBALANCE_RATIO=0.80)', () => {
    // pool_a=790, pool_b=210 → ratio ≈ 0.79
    const result = engine.evaluateMarketRisk(makeMarket(790, 210));

    expect(result.action).toBe('none');
  });

  // ── Absolute pool cap → cap ─────────────────────────────────────────────
  it('returns action=cap when total_pool exceeds MAX_MARKET_POOL_XLM', () => {
    // 100 001 XLM in stroops = 100_001 * 10_000_000
    const stroops = 100_001 * 10_000_000;
    // Perfectly balanced so imbalance does NOT trigger, but absolute cap does.
    const result = engine.evaluateMarketRisk(makeMarket(stroops / 2, stroops / 2));

    expect(result.absolute_breach).toBe(true);
    expect(result.action).toBe('cap');
  });

  // ── Empty pools → safe default ──────────────────────────────────────────
  it('returns action=none and ratio=0.5 for empty pools', () => {
    const result = engine.evaluateMarketRisk(makeMarket(0, 0));

    expect(result.imbalance_ratio).toBe(0.5);
    expect(result.action).toBe('none');
  });

  // ── Null pool values (DB defaults) ──────────────────────────────────────
  it('treats null pool values as zero (safe default)', () => {
    const result = engine.evaluateMarketRisk({ pool_a: null, pool_b: null });

    expect(result.action).toBe('none');
  });

  // ── Exact critical threshold edge ───────────────────────────────────────
  it('locks exactly at CRITICAL_IMBALANCE_RATIO (boundary inclusive)', () => {
    // ratio = 0.95 exactly → should be lock not warn
    const result = engine.evaluateMarketRisk(makeMarket(950, 50));
    expect(result.action).toBe('lock');
  });

  // ── Critical threshold overrides imbalance when both would apply ─────────
  it('cap action takes precedence over imbalance-based lock', () => {
    // Exceeds absolute cap AND has critical imbalance — cap wins.
    const stroops = 200_000 * 10_000_000;
    const result = engine.evaluateMarketRisk(makeMarket(stroops * 0.96, stroops * 0.04));

    expect(result.absolute_breach).toBe(true);
    expect(result.action).toBe('cap');
  });

  // ── Runtime-configurable thresholds ─────────────────────────────────────
  it('respects updated MAX_IMBALANCE_RATIO at runtime without restart', () => {
    process.env.MAX_IMBALANCE_RATIO = '0.60';
    // ratio = 0.65 → should now warn under the new threshold
    const result = engine.evaluateMarketRisk(makeMarket(650, 350));

    expect(result.action).toBe('warn');
  });
});
