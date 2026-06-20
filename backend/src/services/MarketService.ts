// ============================================================
// BOXMEOUT — Market Service
// Business logic layer between controllers and the DB/chain.
// Contributors: implement every function marked TODO.
// ============================================================

import type { Market, MarketStats, PlatformStats } from '../models/Market';
import type { Bet } from '../models/Bet';
import { pool } from '../config/db';
import * as cache from './cache.service';
import * as StellarService from './StellarService';
import { AppError } from '../utils/AppError';

// ---------------------------------------------------------------------------
// DB adapter — thin abstraction so tests can inject a mock
// ---------------------------------------------------------------------------
export interface DbAdapter {
  findMarkets(filters?: MarketFilters): Promise<Market[]>;
  findMarketById(market_id: string): Promise<Market | null>;
  findBetsByAddress(bettor_address: string): Promise<Bet[]>;
  findBetsByMarket(market_id: string, bettor_address?: string): Promise<Bet[]>;
  updateMarketStatus(market_id: string, status: string): Promise<void>;
}

let _db: DbAdapter | null = null;

export function setDbAdapter(adapter: DbAdapter): void {
  _db = adapter;
}

function db(): DbAdapter {
  if (!_db) throw new Error('DbAdapter not initialised');
  return _db;
}

export { db };

export interface MarketFilters {
  status?: string;
  weight_class?: string;
  fighter?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface Pagination {
  page: number;
  limit: number;
}

export interface MarketListResult {
  markets: Market[];
  total: number;
}

export interface MarketOdds {
  odds_a: number;   // Implied probability in basis points
  odds_b: number;
  odds_draw: number;
}

export interface MarketWithOdds extends Market {
  odds: MarketOdds;
}

export interface OutcomeOdds {
  outcome: string;
  multiplier: number;
  implied_probability: number;
  pool: string;
  total_pool: string;
}

export interface AllOutcomeOdds {
  market_id: string;
  fighter_a: OutcomeOdds;
  fighter_b: OutcomeOdds;
  draw: OutcomeOdds;
  total_pool: string;
}

export interface Portfolio {
  address: string;
  active_bets: Bet[];
  past_bets: Bet[];
  total_staked_xlm: number;
  total_won_xlm: number;
  total_lost_xlm: number;
  pending_claims: Bet[];
}

export interface BettorStats {
  bettor_address: string;
  total_bets: number;
  total_wagered_xlm: number;
  total_winnings_xlm: number;
  win_rate: number;
  favorite_fighter: string | null;
}

export interface ProjectedPayout {
  amount: string;
  formatted_xlm: number;
}

/**
 * Returns paginated markets from the database.
 *
 * Steps:
 *   1. Build WHERE clause from filters (status, weight_class, fighter name, date range)
 *   2. Apply pagination (LIMIT / OFFSET)
 *   3. Check Redis cache — return cached result if fresh (TTL 30s)
 *   4. Query DB if cache miss; store result in cache before returning
 *   5. Sort by scheduled_at DESC by default
 */
export async function getMarkets(
  filters?: MarketFilters,
  pagination?: Pagination,
): Promise<MarketListResult> {
  const statusKey = filters?.status ?? '';
  const weightKey = filters?.weight_class ?? '';
  const fighterKey = filters?.fighter ?? '';
  const dateFromKey = filters?.dateFrom?.toISOString() ?? '';
  const dateToKey = filters?.dateTo?.toISOString() ?? '';
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;
  const cacheKey = `markets:${statusKey}:${weightKey}:${fighterKey}:${dateFromKey}:${dateToKey}:${page}:${limit}`;
  const cached = await cache.get<MarketListResult>(cacheKey);
  if (cached) return cached;

  let result: MarketListResult;
  if (_db) {
    const markets = await db().findMarkets(filters);
    const filtered = markets.filter((market) => {
      if (filters?.status && market.status !== filters.status) return false;
      if (filters?.weight_class && market.weight_class !== filters.weight_class) return false;
      if (filters?.fighter) {
        const fighterLower = filters.fighter.toLowerCase();
        if (!market.fighter_a.toLowerCase().includes(fighterLower) && 
            !market.fighter_b.toLowerCase().includes(fighterLower)) {
          return false;
        }
      }
      if (filters?.dateFrom && new Date(market.scheduled_at) < filters.dateFrom) return false;
      if (filters?.dateTo && new Date(market.scheduled_at) > filters.dateTo) return false;
      return true;
    });

    const sorted = [...filtered].sort(
      (a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime(),
    );

    const offset = (page - 1) * limit;
    const paged = sorted.slice(offset, offset + limit);
    result = { markets: paged, total: sorted.length };
  } else {
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    if (filters?.status) {
      values.push(filters.status);
      whereClauses.push(`status = $${values.length}`);
    }
    if (filters?.weight_class) {
      values.push(filters.weight_class);
      whereClauses.push(`weight_class = $${values.length}`);
    }
    if (filters?.fighter) {
      values.push(`%${filters.fighter}%`);
      whereClauses.push(`(fighter_a ILIKE $${values.length} OR fighter_b ILIKE $${values.length})`);
    }
    if (filters?.dateFrom) {
      values.push(filters.dateFrom);
      whereClauses.push(`scheduled_at >= $${values.length}`);
    }
    if (filters?.dateTo) {
      values.push(filters.dateTo);
      whereClauses.push(`scheduled_at <= $${values.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const rows = await pool.query(
      `SELECT * FROM markets ${whereSql} ORDER BY scheduled_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const countRows = await pool.query(
      `SELECT COUNT(*) AS total FROM markets ${whereSql}`,
      values,
    );

    result = {
      markets: rows.rows.map((row) => ({
        ...row,
        scheduled_at: new Date(row.scheduled_at),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
      } as Market)),
      total: Number(countRows.rows[0]?.total ?? 0),
    };
  }

  await cache.set(cacheKey, result, 30);
  return result;
}

/**
 * Invalidates cache for a market when it's updated.
 * Clears the market cache and related pattern caches.
 */
export async function invalidateMarketCache(market_id: string): Promise<void> {
  await cache.del(`market:${market_id}`);
  await cache.delPattern(`markets:*`);
  await cache.del(`market:${market_id}:stats`);
}

/**
 * Returns a single market by its on-chain market_id string, enriched with
 * live odds from getMarketOdds().
 *
 * Steps:
 *   1. Check Redis cache — return cached result if fresh (TTL 10s)
 *   2. Query DB; throw AppError 404 if no row found
 *   3. Fetch live odds via getMarketOdds()
 *   4. Merge market + odds, store in cache for 10 seconds, then return
 */
export async function getMarketById(market_id: string): Promise<MarketWithOdds> {
  const cacheKey = `market:${market_id}`;
  const cached = await cache.get<MarketWithOdds>(cacheKey);
  if (cached) return cached;

  const market = await db().findMarketById(market_id);
  if (!market) throw AppError.notFound(`Market not found: ${market_id}`);

  const odds = await getMarketOdds(market_id);
  const result: MarketWithOdds = { ...market, odds };

  await cache.set(cacheKey, result, 10);
  return result;
}

// ---------------------------------------------------------------------------
// LMSR helpers (TypeScript may use Math.exp/Math.log; only the Soroban WASM contract
// is restricted to integer arithmetic)
// ---------------------------------------------------------------------------

/** LMSR default b = 1000 XLM in stroops. Used when the DB row lacks lmsr_b. */
const LMSR_B_DEFAULT = 10_000_000_000n;

/**
 * LMSR cost function: C(q) = b * ln(e^(q_a/b) + e^(q_b/b) + e^(q_d/b)).
 * Uses log-sum-exp trick (subtract max) for numerical stability.
 */
function lmsrCostFn(q_a: number, q_b: number, q_d: number, b: number): number {
  const xA = q_a / b;
  const xB = q_b / b;
  const xD = q_d / b;
  const maxX = Math.max(xA, xB, xD);
  return b * (maxX + Math.log(Math.exp(xA - maxX) + Math.exp(xB - maxX) + Math.exp(xD - maxX)));
}

/**
 * LMSR implied probabilities for a 3-outcome market, expressed in basis points (0..10000).
 * p_i = e^(q_i/b) / Σ e^(q_j/b).
 * Uses log-sum-exp trick for numerical stability.
 * Returns uniform prior {a:3333, b:3333, draw:3334} when all pools are zero.
 */
function lmsrPriceBps(
  q_a: bigint, q_b: bigint, q_draw: bigint, b: bigint,
): { a: number; b: number; draw: number } {
  const bF = Number(b);
  const xA = Number(q_a) / bF;
  const xB = Number(q_b) / bF;
  const xD = Number(q_draw) / bF;

  const maxX = Math.max(xA, xB, xD);
  const eA = Math.exp(xA - maxX);
  const eB = Math.exp(xB - maxX);
  const eD = Math.exp(xD - maxX);
  const sum = eA + eB + eD;

  const pA = Math.floor((eA / sum) * 10000);
  const pB = Math.floor((eB / sum) * 10000);
  const pD = 10000 - pA - pB; // assign remainder to draw so bps sum to exactly 10000

  return { a: pA, b: pB, draw: pD };
}

/**
 * LMSR marginal cost for a bet of `delta` stroops on `outcome` given current pools.
 * cost = C(q + Δe_i) - C(q). Always less than delta.
 */
function lmsrMarginalCost(
  q_a: bigint, q_b: bigint, q_draw: bigint, delta: bigint, outcome: string, b: bigint,
): bigint {
  const bF = Number(b);
  const qA = Number(q_a); const qB = Number(q_b); const qD = Number(q_draw);
  const dF = Number(delta);
  const before = lmsrCostFn(qA, qB, qD, bF);
  const after = outcome === 'fighter_a'
    ? lmsrCostFn(qA + dF, qB, qD, bF)
    : outcome === 'fighter_b'
      ? lmsrCostFn(qA, qB + dF, qD, bF)
      : lmsrCostFn(qA, qB, qD + dF, bF);
  return BigInt(Math.round(after - before));
}

// ---------------------------------------------------------------------------

/**
 * Returns live LMSR odds for a market in basis points.
 * Computes p_i = e^(q_i/b) / Σ e^(q_j/b) from pool quantities stored in DB.
 * Falls back to on-chain read when DB row is stale (updated_at > 30 s ago).
 */
export async function getMarketOdds(market_id: string): Promise<MarketOdds> {
  const market = await db().findMarketById(market_id);
  if (!market) throw AppError.notFound(`Market not found: ${market_id}`);

  const now = new Date();
  const isStale = (now.getTime() - market.updated_at.getTime()) > 30_000;

  let q_a: bigint, q_b: bigint, q_draw: bigint;

  if (isStale) {
    const onChainData = await StellarService.readContractState(market.contract_address, 'get_state', []) as { pool_a: string; pool_b: string; pool_draw: string };
    q_a = BigInt(onChainData.pool_a);
    q_b = BigInt(onChainData.pool_b);
    q_draw = BigInt(onChainData.pool_draw);
  } else {
    q_a = BigInt(market.pool_a);
    q_b = BigInt(market.pool_b);
    q_draw = BigInt(market.pool_draw);
  }

  const b = BigInt(market.lmsr_b ?? LMSR_B_DEFAULT);
  const { a, b: bps_b, draw } = lmsrPriceBps(q_a, q_b, q_draw, b);
  return { odds_a: a, odds_b: bps_b, odds_draw: draw };
}


/** Shared market loader for odds calculations. */
async function loadMarketPools(market_id: string) {
  const market = await db().findMarketById(market_id);
  if (!market) throw AppError.notFound(`Market not found: ${market_id}`);
  return {
    totalPool: BigInt(market.total_pool),
    poolA: BigInt(market.pool_a),
    poolB: BigInt(market.pool_b),
    poolDraw: BigInt(market.pool_draw),
    feeBps: market.fee_bps,
    totalPoolStr: market.total_pool,
    b: BigInt(market.lmsr_b ?? LMSR_B_DEFAULT),
  };
}

/**
 * Build an OutcomeOdds from LMSR implied probability (basis points).
 *
 * LMSR payout multiplier = (net_pool / winning_pool) ≈ (1 - fee) / p_i for large pools.
 * For small/empty pools we fall back to the LMSR probability directly.
 *
 * implied_probability — directly from LMSR p_i in bps → percent.
 * multiplier          — (net_pool / outcome_pool) when outcome_pool > 0, else 0.
 */
function buildOutcomeOdds(
  priceBps: number,
  outcomePool: bigint,
  totalPool: bigint,
  feeBps: number,
  outcome: string,
  totalPoolStr: string,
): OutcomeOdds {
  const implied_probability = priceBps / 100;

  let multiplier = 0;
  if (outcomePool > 0n && totalPool > 0n) {
    const fee = (totalPool * BigInt(feeBps)) / 10000n;
    const netPool = totalPool - fee;
    multiplier = Math.round((Number(netPool) / Number(outcomePool)) * 100) / 100;
  }

  return {
    outcome,
    multiplier,
    implied_probability: Math.round(implied_probability * 100) / 100,
    pool: outcomePool.toString(),
    total_pool: totalPoolStr,
  };
}

/**
 * Returns LMSR-derived odds for a single outcome.
 * implied_probability = e^(q_i/b) / Σ e^(q_j/b).
 * multiplier = net_pool / outcome_pool (parimutuel payout on LMSR-accumulated pools).
 */
export async function calculateSingleOutcomeOdds(
  market_id: string,
  outcome: 'fighter_a' | 'fighter_b' | 'draw',
): Promise<OutcomeOdds> {
  const { totalPool, poolA, poolB, poolDraw, feeBps, totalPoolStr, b } = await loadMarketPools(market_id);
  const prices = lmsrPriceBps(poolA, poolB, poolDraw, b);
  const priceBps = outcome === 'fighter_a' ? prices.a : outcome === 'fighter_b' ? prices.b : prices.draw;
  const pool = outcome === 'fighter_a' ? poolA : outcome === 'fighter_b' ? poolB : poolDraw;
  return buildOutcomeOdds(priceBps, pool, totalPool, feeBps, outcome, totalPoolStr);
}

/**
 * Returns LMSR-derived odds for all three outcomes.
 * implied_probability = e^(q_i/b) / Σ e^(q_j/b), expressed as a percentage.
 * multiplier = net_pool / outcome_pool (parimutuel payout on LMSR-accumulated pools).
 */
export async function calculateOutcomeOdds(market_id: string): Promise<AllOutcomeOdds> {
  const { totalPool, poolA, poolB, poolDraw, feeBps, totalPoolStr, b } = await loadMarketPools(market_id);
  const prices = lmsrPriceBps(poolA, poolB, poolDraw, b);

  return {
    market_id,
    fighter_a: buildOutcomeOdds(prices.a, poolA, totalPool, feeBps, 'fighter_a', totalPoolStr),
    fighter_b: buildOutcomeOdds(prices.b, poolB, totalPool, feeBps, 'fighter_b', totalPoolStr),
    draw: buildOutcomeOdds(prices.draw, poolDraw, totalPool, feeBps, 'draw', totalPoolStr),
    total_pool: totalPoolStr,
  };
}

/**
 * Returns all bets placed by a given Stellar address across all markets.
 * Returns an empty array (never 404) when the address has no bets.
 */
export async function getBetsByAddress(bettor_address: string): Promise<Bet[]> {
  if (_db) {
    return db().findBetsByAddress(bettor_address);
  }

  const { rows } = await pool.query(
    'SELECT * FROM bets WHERE bettor_address = $1 ORDER BY placed_at DESC',
    [bettor_address],
  );

  return rows.map((row) => ({
    ...row,
    placed_at: new Date(row.placed_at),
    claimed_at: row.claimed_at ? new Date(row.claimed_at) : null,
  } as Bet));
}

/**
 * Returns aggregate statistics for a bettor address.
 * Totals are computed in XLM (divide stroops by 10_000_000).
 * Returns zeroed stats when no bets exist.
 */
export async function getBettorStats(bettor_address: string): Promise<BettorStats> {
  const bets = await getBetsByAddress(bettor_address);
  const total_bets = bets.length;
  const total_wagered_xlm = bets.reduce((sum, bet) => sum + Number(bet.amount) / 10_000_000, 0);
  const total_winnings_xlm = bets
    .filter((bet) => bet.claimed && bet.payout)
    .reduce((sum, bet) => sum + Number(bet.payout ?? '0') / 10_000_000, 0);

  const outcomeCounts = bets.reduce<Record<string, number>>((counts, bet) => {
    counts[bet.side] = (counts[bet.side] ?? 0) + 1;
    return counts;
  }, {});

  const favorite_fighter = Object.entries(outcomeCounts).reduce<string | null>((best, [side, count]) => {
    if (best === null) return side;
    return count > (outcomeCounts[best] ?? 0) ? side : best;
  }, null);

  const win_rate = total_bets === 0
    ? 0
    : Math.round((bets.filter((bet) => bet.claimed && bet.payout).length * 10000) / total_bets) / 100;

  return {
    bettor_address,
    total_bets,
    total_wagered_xlm,
    total_winnings_xlm,
    win_rate,
    favorite_fighter,
  };
}

/**
 * Returns all bets for a given market.
 * If bettor_address is provided, filters to only that bettor's bets.
 */
export async function getBetsByMarket(
  market_id: string,
  bettor_address?: string,
): Promise<Bet[]> {
  if (_db) {
    return db().findBetsByMarket(market_id, bettor_address);
  }

  const values: unknown[] = [market_id];
  let sql = 'SELECT * FROM bets WHERE market_id = $1';

  if (bettor_address) {
    values.push(bettor_address);
    sql += ` AND bettor_address = $${values.length}`;
  }

  sql += ' ORDER BY placed_at DESC';

  const { rows } = await pool.query(sql, values);
  return rows.map((row) => ({
    ...row,
    placed_at: new Date(row.placed_at),
    claimed_at: row.claimed_at ? new Date(row.claimed_at) : null,
  } as Bet));
}

/**
 * Returns aggregate statistics for a market.
 * Values are computed from the bets table, not from on-chain.
 * Results cached in Redis for 60 seconds.
 */
export async function getMarketStats(market_id: string): Promise<MarketStats> {
  const cacheKey = `market:${market_id}:stats`;
  const cached = await cache.get<MarketStats>(cacheKey);
  if (cached) return cached;

  const bets = await db().findBetsByMarket(market_id);

  const total_bets = bets.length;
  const unique_bettors = new Set(bets.map(b => b.bettor_address)).size;
  const amounts_xlm = bets.map(b => Number(b.amount) / 10_000_000);
  const largest_bet_xlm = amounts_xlm.length > 0 ? Math.max(...amounts_xlm) : 0;
  const average_bet_xlm = amounts_xlm.length > 0 ? amounts_xlm.reduce((s, a) => s + a, 0) / amounts_xlm.length : 0;
  const total_pooled_xlm = amounts_xlm.reduce((s, a) => s + a, 0);

  const stats: MarketStats = {
    market_id,
    total_bets,
    unique_bettors,
    largest_bet_xlm,
    average_bet_xlm,
    total_pooled_xlm,
  };

  await cache.set(cacheKey, stats, 60);
  return stats;
}

/**
 * Returns a portfolio summary for a Stellar address.
 *
 * active_bets:    bets in Open/Locked markets
 * past_bets:      bets in Resolved/Cancelled markets
 * pending_claims: unclaimed winning bets in Resolved markets
 * Totals are computed in XLM (divide stroops by 10_000_000).
 */
export async function getPortfolioByAddress(
  bettor_address: string,
): Promise<Portfolio> {
  const bets = await db().findBetsByAddress(bettor_address);
  const marketIds = [...new Set(bets.map(b => b.market_id))];
  const markets = await Promise.all(marketIds.map(id => db().findMarketById(id)));
  const marketMap = new Map(markets.filter(Boolean).map(m => [m!.market_id, m!]));

  const active_bets: Bet[] = [];
  const past_bets: Bet[] = [];
  const pending_claims: Bet[] = [];

  for (const bet of bets) {
    const market = marketMap.get(bet.market_id);
    const status = market?.status;
    if (status === 'open' || status === 'locked') {
      active_bets.push(bet);
    } else {
      past_bets.push(bet);
      if (status === 'resolved' && !bet.claimed && market?.outcome === bet.side) {
        pending_claims.push(bet);
      }
    }
  }

  const total_staked_xlm = bets.reduce((s, b) => s + Number(b.amount) / 10_000_000, 0);
  const total_won_xlm = bets
    .filter(b => b.claimed && b.payout)
    .reduce((s, b) => s + Number(b.payout) / 10_000_000, 0);
  const total_lost_xlm = past_bets
    .filter(b => !b.claimed && !pending_claims.includes(b))
    .reduce((s, b) => s + Number(b.amount) / 10_000_000, 0);

  return {
    address: bettor_address,
    active_bets,
    past_bets,
    total_staked_xlm,
    total_won_xlm,
    total_lost_xlm,
    pending_claims,
  };
}

/**
 * Simulates projected payout for a hypothetical bet on a market using LMSR pricing.
 *
 * Steps:
 *   1. Compute LMSR marginal cost: cost = C(q + Δe_i) - C(q)  (cost ≤ amount always)
 *   2. Projected winning pool after this bet: outcome_pool + cost
 *   3. Projected total pool: total_pool + cost
 *   4. Projected net pool: (total_pool + cost) * (1 - fee)
 *   5. Projected payout: cost / (outcome_pool + cost) * net_pool
 *
 * Returns zero when the market is cancelled or amount is non-positive.
 */
export async function simulateProjectedPayout(
  market_id: string,
  amount: string,
  outcome: 'fighter_a' | 'fighter_b' | 'draw',
): Promise<ProjectedPayout> {
  const market = await db().findMarketById(market_id);
  if (!market) throw AppError.notFound(`Market not found: ${market_id}`);

  if (market.status === 'cancelled') return { amount: '0', formatted_xlm: 0 };

  const delta = BigInt(amount);
  if (delta <= 0n) return { amount: '0', formatted_xlm: 0 };

  const q_a = BigInt(market.pool_a);
  const q_b = BigInt(market.pool_b);
  const q_draw = BigInt(market.pool_draw);
  const total_pool = BigInt(market.total_pool);
  const b = BigInt(market.lmsr_b ?? LMSR_B_DEFAULT);

  const cost = lmsrMarginalCost(q_a, q_b, q_draw, delta, outcome, b);
  if (cost <= 0n) return { amount: '0', formatted_xlm: 0 };

  const winning_pool_before = outcome === 'fighter_a' ? q_a : outcome === 'fighter_b' ? q_b : q_draw;
  const winning_pool_after = winning_pool_before + cost;
  const total_after = total_pool + cost;
  const fee = (total_after * BigInt(market.fee_bps)) / 10000n;
  const net_pool = total_after - fee;

  const payout = (cost * net_pool) / winning_pool_after;
  return {
    amount: payout.toString(),
    formatted_xlm: Number(payout) / 10_000_000,
  };
}

/**
 * Returns aggregate platform statistics for the home page banner.
 * Queries: COUNT(*) WHERE status='Open', SUM(total_pool), COUNT(bets)
 * Results cached in Redis for 60 seconds.
 */
export interface LeaderboardEntry {
  rank: number;
  bettor_address: string;
  total_staked_xlm: number;
  total_won_xlm: number;
  bet_count: number;
  win_rate: number;
}

/**
 * Returns ranked leaderboard entries aggregated from the bets table.
 * @param metric - Sort criterion: 'won' (total_won_xlm DESC), 'bets' (bet_count DESC), 'winrate' (win_rate DESC, min 10 bets)
 * @param limit  - Max rows (default 50)
 * Results cached in Redis for 60 seconds.
 */
export async function getLeaderboard(
  metric: 'won' | 'bets' | 'winrate',
  limit: number = 50,
): Promise<LeaderboardEntry[]> {
  const cacheKey = `leaderboard:${metric}:${limit}`;
  const cached = await cache.get<LeaderboardEntry[]>(cacheKey);
  if (cached) return cached;

  let rows: LeaderboardEntry[];
  if (_db) {
    const allMarkets = await db().findMarkets();
    const allBets = (
      await Promise.all(allMarkets.map((m) => db().findBetsByMarket(m.market_id)))
    ).flat();

    const map = new Map<string, { staked: number; won: number; count: number; wins: number }>();
    for (const bet of allBets) {
      const addr = bet.bettor_address;
      const entry = map.get(addr) ?? { staked: 0, won: 0, count: 0, wins: 0 };
      entry.staked += Number(bet.amount) / 10_000_000;
      if (bet.claimed && bet.payout) {
        entry.won += Number(bet.payout) / 10_000_000;
        entry.wins += 1;
      }
      entry.count += 1;
      map.set(addr, entry);
    }

    rows = [...map.entries()].map(([bettor_address, d]) => ({
      rank: 0,
      bettor_address,
      total_staked_xlm: Math.round(d.staked * 100) / 100,
      total_won_xlm: Math.round(d.won * 100) / 100,
      bet_count: d.count,
      win_rate: d.count === 0 ? 0 : Math.round((d.wins / d.count) * 10000) / 100,
    }));

    if (metric === 'won') rows.sort((a, b) => b.total_won_xlm - a.total_won_xlm);
    else if (metric === 'bets') rows.sort((a, b) => b.bet_count - a.bet_count);
    else {
      rows = rows.filter((r) => r.bet_count >= 10);
      rows.sort((a, b) => b.win_rate - a.win_rate);
    }

    rows = rows.slice(0, limit);
    rows.forEach((r, i) => { r.rank = i + 1; });
  } else {
    const orderClause =
      metric === 'won'
        ? 'SUM(COALESCE(b.payout, 0)) DESC'
        : metric === 'bets'
          ? 'COUNT(*) DESC'
          : 'ROUND(COUNT(*) FILTER (WHERE b.claimed AND b.payout IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) DESC';

    const havingClause = metric === 'winrate' ? 'HAVING COUNT(*) >= 10' : '';

    const query = `
      SELECT
        b.bettor_address,
        ROUND(SUM(b.amount_xlm)::numeric, 2) AS total_staked_xlm,
        ROUND(SUM(COALESCE(b.payout, 0)) / 10000000.0, 2) AS total_won_xlm,
        COUNT(*) AS bet_count,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(COUNT(*) FILTER (WHERE b.claimed AND b.payout IS NOT NULL)::numeric / COUNT(*) * 100, 2)
        END AS win_rate
      FROM bets b
      GROUP BY b.bettor_address
      ${havingClause}
      ORDER BY ${orderClause}
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    rows = result.rows.map((r: any, i: number) => ({
      rank: i + 1,
      bettor_address: r.bettor_address,
      total_staked_xlm: Number(r.total_staked_xlm) || 0,
      total_won_xlm: Number(r.total_won_xlm) || 0,
      bet_count: Number(r.bet_count) || 0,
      win_rate: Number(r.win_rate) || 0,
    }));
  }

  await cache.set(cacheKey, rows, 60);
  return rows;
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const cacheKey = 'platform:stats';
  const cached = await cache.get<PlatformStats>(cacheKey);
  if (cached) return cached;

  if (_db) {
    // If using test adapter, compute from in-memory data
    const allMarkets = await db().findMarkets();
    const openMarkets = allMarkets.filter(m => m.status === 'open');
    const allBets = await Promise.all(
      allMarkets.map(m => db().findBetsByMarket(m.market_id))
    ).then(results => results.flat());

    const totalVolume = allMarkets.reduce((sum, m) => sum + Number(m.total_pool) / 10_000_000, 0);

    const stats: PlatformStats = {
      totalMarkets: allMarkets.length,
      activeMarkets: openMarkets.length,
      totalVolume,
      totalBets: allBets.length,
    };

    await cache.set(cacheKey, stats, 60);
    return stats;
  }

  const marketsResult = await pool.query(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as active, SUM(total_pool) as volume FROM markets"
  );

  const betsResult = await pool.query('SELECT COUNT(*) as total FROM bets');

  const { total: totalMarkets, active: activeMarkets, volume: totalPoolStroops } = marketsResult.rows[0];
  const { total: totalBets } = betsResult.rows[0];

  const stats: PlatformStats = {
    totalMarkets: Number(totalMarkets) || 0,
    activeMarkets: Number(activeMarkets) || 0,
    totalVolume: (Number(totalPoolStroops) || 0) / 10_000_000,
    totalBets: Number(totalBets) || 0,
  };

  await cache.set(cacheKey, stats, 60);
  return stats;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export interface BulkResult {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

/**
 * Pauses (locks) up to 50 open markets in a single admin action.
 * Each market is processed independently — failures do not abort others.
 */
export async function bulkPauseMarkets(marketIds: string[]): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };

  for (const id of marketIds) {
    try {
      const { rows } = await pool.query(
        `UPDATE markets SET status = 'locked', updated_at = NOW()
         WHERE market_id = $1 AND status = 'open'
         RETURNING market_id`,
        [id],
      );
      if (rows.length === 0) {
        result.failed.push({ id, reason: 'Market not found or not in open status' });
      } else {
        await invalidateMarketCache(id);
        result.succeeded.push(id);
      }
    } catch (err) {
      result.failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * Cancels up to 50 open/locked markets and enqueues notifications for all
 * position holders of each successfully cancelled market.
 * Each market is processed independently — failures do not abort others.
 */
export async function bulkCancelMarkets(
  marketIds: string[],
  reason: string,
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };

  for (const id of marketIds) {
    try {
      const { rows } = await pool.query(
        `UPDATE markets SET status = 'cancelled', updated_at = NOW()
         WHERE market_id = $1 AND status IN ('open', 'locked')
         RETURNING market_id`,
        [id],
      );
      if (rows.length === 0) {
        result.failed.push({ id, reason: 'Market not found or not cancellable' });
        continue;
      }

      await invalidateMarketCache(id);

      // Enqueue notifications for all position holders
      const bettors = await pool.query(
        `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
        [id],
      );
      if (bettors.rows.length > 0) {
        const values = bettors.rows
          .map((_: unknown, i: number) => `($${i * 4 + 1}, $${i * 4 + 2}, 'market_cancelled', 'pending', NOW())`)
          .join(', ');
        const params = bettors.rows.flatMap((r: { bettor_address: string }) => [r.bettor_address, id]);
        await pool.query(
          `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at) VALUES ${values}`,
          params,
        );
      }

      result.succeeded.push(id);
    } catch (err) {
      result.failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
