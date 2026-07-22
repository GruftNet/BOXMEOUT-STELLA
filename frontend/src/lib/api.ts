// ============================================================
// BOXMEOUT — lib/api helpers
// Shared types and fetch utilities for odds and market data.
// ============================================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OutcomeOdds {
  /** Implied probability in basis points (0–10000) */
  odds_bps: number;
  /** Payout multiplier (e.g. 1.95 means 1.95× your stake) */
  multiplier: number;
  /** Current pool amount in XLM */
  pool_xlm: number;
}

export interface MarketOdds {
  market_id: string;
  fighter_a: OutcomeOdds;
  fighter_b: OutcomeOdds;
  draw: OutcomeOdds;
  fee_bps: number;
  last_updated: string;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Fetch live odds for a market.
 * Falls back to computing odds from the market's pool data when the dedicated
 * /odds endpoint is unavailable.
 */
export async function fetchOdds(marketId: string): Promise<MarketOdds> {
  const res = await fetch(`${API_BASE}/api/markets/${marketId}/odds`);
  if (!res.ok) {
    // Fall back to pool-based odds from the market endpoint
    const marketRes = await fetch(`${API_BASE}/api/markets/${marketId}`);
    if (!marketRes.ok) throw new Error(`Failed to fetch odds for market ${marketId}`);
    const market = await marketRes.json();

    const poolA = Number(market.pool_a) / 1e7;
    const poolB = Number(market.pool_b) / 1e7;
    const poolDraw = Number(market.pool_draw) / 1e7;
    const total = poolA + poolB + poolDraw || 1;
    const fee = 1 - market.fee_bps / 10000;

    const toOdds = (pool: number): OutcomeOdds => ({
      odds_bps: Math.round((pool / total) * 10000),
      multiplier: pool > 0 ? parseFloat(((total / pool) * fee).toFixed(4)) : 0,
      pool_xlm: pool,
    });

    return {
      market_id: marketId,
      fighter_a: toOdds(poolA),
      fighter_b: toOdds(poolB),
      draw: toOdds(poolDraw),
      fee_bps: market.fee_bps,
      last_updated: new Date().toISOString(),
    };
  }
  return res.json() as Promise<MarketOdds>;
}
