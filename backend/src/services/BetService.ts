// ============================================================
// BOXMEOUT — Bet Service
// Business logic for bet operations: recording, fetching, payouts
// ============================================================

import type { Bet } from '../models/Bet';
import { pool } from '../config/db';
import { cacheDelete, cacheDeletePattern } from './cache.service';
import { AppError } from '../utils/AppError';
import { Address, xdr } from '@stellar/stellar-sdk';
import { invokeContract } from './StellarService';
import { emitBetPlaced } from '../websocket/realtime';

export interface BetWithMarket extends Bet {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  status: string;
}

export interface FetchBetsResult {
  bets: BetWithMarket[];
  total: number;
}

export interface ProjectedPayout {
  amount: string;
  formatted_xlm: number;
}

/**
 * Records a bet triggered by a BetPlaced blockchain event.
 * 
 * Steps:
 *   1. Validate inputs
 *   2. Insert Bet record with tx_hash as unique key (idempotent)
 *   3. Update User.total_wagered and User.total_bets
 *   4. Invalidate Redis cache for the market
 */
export async function recordBet(
  market_id: string,
  bettor_address: string,
  side: 'fighter_a' | 'fighter_b' | 'draw',
  amount: string,
  tx_hash: string,
  ledger_sequence: number,
  original_token?: string,
  original_amount?: string,
): Promise<Bet> {
  if (!market_id || !bettor_address || !side || !amount || !tx_hash) {
    throw AppError.badRequest('Missing required bet fields');
  }

  // Validate Stellar address format (G followed by 55 alphanumeric chars)
  if (!/^G[A-Z2-7]{55}$/.test(bettor_address)) {
    throw AppError.badRequest('Invalid Stellar address format');
  }

  // Default to XLM if not specified
  const token = original_token || 'XLM';
  const origAmount = original_amount || amount;
  const amount_xlm = Number(amount) / 10_000_000;

  try {
    const result = await pool.query(
      `INSERT INTO bets (market_id, bettor_address, side, amount, amount_xlm, original_token, original_amount, tx_hash, ledger_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tx_hash) DO UPDATE SET tx_hash = EXCLUDED.tx_hash
       RETURNING *`,
      [market_id, bettor_address, side, amount, amount_xlm, token, origAmount, tx_hash, ledger_sequence],
    );

    const bet = result.rows[0];

    // Invalidate market cache
    await cacheDeletePattern(`market:${market_id}*`);
    await cacheDeletePattern('platform:stats');

    // Notify the RiskEngine so it can re-evaluate pool exposure in real time.
    emitBetPlaced(market_id);

    return {
      ...bet,
      placed_at: new Date(bet.placed_at),
      claimed_at: bet.claimed_at ? new Date(bet.claimed_at) : null,
    } as Bet;
  } catch (error) {
    if ((error as any).code === '23505') {
      // Unique constraint violation on tx_hash — idempotent, return existing bet
      const existing = await pool.query(
        'SELECT * FROM bets WHERE tx_hash = $1',
        [tx_hash],
      );
      if (existing.rows.length > 0) {
        const bet = existing.rows[0];
        return {
          ...bet,
          placed_at: new Date(bet.placed_at),
          claimed_at: bet.claimed_at ? new Date(bet.claimed_at) : null,
        } as Bet;
      }
    }
    throw error;
  }
}

/**
 * Fetches paginated bets for a Stellar address.
 * 
 * Steps:
 *   1. Validate Stellar address format
 *   2. JOIN with markets table to include market info
 *   3. Sort by placed_at DESC
 *   4. Apply pagination (LIMIT / OFFSET)
 *   5. Return { bets: BetWithMarket[], total: number }
 */
export async function fetchBetsByAddress(
  bettor_address: string,
  page: number = 1,
  limit: number = 50,
): Promise<FetchBetsResult> {
  // Validate Stellar address format
  if (!/^G[A-Z2-7]{55}$/.test(bettor_address)) {
    throw AppError.badRequest('Invalid Stellar address format');
  }

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await pool.query(
    'SELECT COUNT(*) as total FROM bets WHERE bettor_address = $1',
    [bettor_address],
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  // Get paginated bets with market info
  const result = await pool.query(
    `SELECT 
       b.id, b.market_id, b.bettor_address, b.side, b.amount, b.amount_xlm,
       b.placed_at, b.claimed, b.claimed_at, b.payout, b.tx_hash, b.ledger_sequence,
       m.fighter_a, m.fighter_b, m.status
     FROM bets b
     JOIN markets m ON b.market_id = m.market_id
     WHERE b.bettor_address = $1
     ORDER BY b.placed_at DESC
     LIMIT $2 OFFSET $3`,
    [bettor_address, limit, offset],
  );

  const bets = result.rows.map((row) => ({
    ...row,
    placed_at: new Date(row.placed_at),
    claimed_at: row.claimed_at ? new Date(row.claimed_at) : null,
  } as BetWithMarket));

  return { bets, total };
}

/**
 * Calculates the projected payout for a specific bettor on a specific market.
 * 
 * Steps:
 *   1. Fetch bettor's BetPosition and market's pool sizes from DB
 *   2. Formula: (amount / winning_pool) * (total_pool - fee)
 *   3. Return "0" if bettor bet on a different outcome
 *   4. Return "0" if market is Cancelled
 */
export async function calculateProjectedPayout(
  market_id: string,
  bettor_address: string,
  outcome: 'fighter_a' | 'fighter_b' | 'draw' | null,
): Promise<ProjectedPayout> {
  // Validate Stellar address format
  if (!/^G[A-Z2-7]{55}$/.test(bettor_address)) {
    throw AppError.badRequest('Invalid Stellar address format');
  }

  // Fetch market
  const marketResult = await pool.query(
    'SELECT * FROM markets WHERE market_id = $1',
    [market_id],
  );

  if (marketResult.rows.length === 0) {
    throw AppError.notFound(`Market not found: ${market_id}`);
  }

  const market = marketResult.rows[0];

  // Return 0 if market is cancelled
  if (market.status === 'cancelled') {
    return { amount: '0', formatted_xlm: 0 };
  }

  // Fetch bettor's bet
  const betResult = await pool.query(
    'SELECT * FROM bets WHERE market_id = $1 AND bettor_address = $2',
    [market_id, bettor_address],
  );

  if (betResult.rows.length === 0) {
    return { amount: '0', formatted_xlm: 0 };
  }

  const bet = betResult.rows[0];

  // Return 0 if bettor bet on a different outcome
  if (!outcome || bet.side !== outcome) {
    return { amount: '0', formatted_xlm: 0 };
  }

  // Calculate payout: (amount / winning_pool) * (total_pool - fee)
  const amount = BigInt(bet.amount);
  const total_pool = BigInt(market.total_pool);
  const fee_bps = market.fee_bps;
  const fee = (total_pool * BigInt(fee_bps)) / 10000n;
  const pool_after_fee = total_pool - fee;

  let winning_pool: bigint;
  if (outcome === 'fighter_a') {
    winning_pool = BigInt(market.pool_a);
  } else if (outcome === 'fighter_b') {
    winning_pool = BigInt(market.pool_b);
  } else {
    winning_pool = BigInt(market.pool_draw);
  }

  if (winning_pool === 0n) {
    return { amount: '0', formatted_xlm: 0 };
  }

  const payout = (amount * pool_after_fee) / winning_pool;
  const formatted_xlm = Number(payout) / 10_000_000;

  return {
    amount: payout.toString(),
    formatted_xlm,
  };
}

/**
 * Submits a claim_winnings transaction on-chain for a winning bettor.
 *
 * Steps:
 *   1. Validate inputs
 *   2. Retrieve market contract address from DB
 *   3. Build ScVal args: [bettor_address, token_address]
 *   4. Call StellarService.invokeContract("claim_winnings", args)
 *   5. Return tx_hash
 *   6. DB is updated asynchronously by the indexer on WinningsClaimed event
 */
export async function claimWinnings(
  market_id: string,
  bettor_address: string,
  token_address: string,
): Promise<string> {
  if (!market_id || !bettor_address || !token_address) {
    throw AppError.badRequest('Missing required claim fields');
  }

  const marketResult = await pool.query(
    'SELECT contract_address FROM markets WHERE market_id = $1',
    [market_id],
  );
  if (marketResult.rowCount === 0) {
    throw AppError.notFound(`Market not found: ${market_id}`);
  }
  const contract_address = marketResult.rows[0].contract_address;

  const bettorScVal = Address.fromString(bettor_address).toScVal();
  const tokenScVal = Address.fromString(token_address).toScVal();

  const tx_hash = await invokeContract(contract_address, 'claim_winnings', [bettorScVal, tokenScVal]);

  return tx_hash;
}

/**
 * Submits a claim_refund transaction on-chain for a cancelled market.
 *
 * Steps:
 *   1. Validate inputs
 *   2. Retrieve market contract address from DB
 *   3. Build ScVal args: [bettor_address, token_address]
 *   4. Call StellarService.invokeContract("claim_refund", args)
 *   5. Return tx_hash
 *   6. DB is updated asynchronously by the indexer on RefundClaimed event
 */
export async function claimRefund(
  market_id: string,
  bettor_address: string,
  token_address: string,
): Promise<string> {
  if (!market_id || !bettor_address || !token_address) {
    throw AppError.badRequest('Missing required refund fields');
  }

  const marketResult = await pool.query(
    'SELECT contract_address FROM markets WHERE market_id = $1',
    [market_id],
  );
  if (marketResult.rowCount === 0) {
    throw AppError.notFound(`Market not found: ${market_id}`);
  }
  const contract_address = marketResult.rows[0].contract_address;

  const bettorScVal = Address.fromString(bettor_address).toScVal();
  const tokenScVal = Address.fromString(token_address).toScVal();

  const tx_hash = await invokeContract(contract_address, 'claim_refund', [bettorScVal, tokenScVal]);

  return tx_hash;
}

/**
 * Processes refunds for ALL unclaimed bettors in a cancelled market.
 *
 * Steps:
 *   1. Validate market is cancelled
 *   2. Find all bettors with unclaimed bets
 *   3. For each bettor, enqueue a notification job
 *   4. Attempt to submit claim_refund on-chain for each bettor
 *      (may fail with AUTH_ERROR since server can't sign for the bettor;
 *       the bettor must claim individually via POST /api/claims/refund)
 *
 * Returns a summary of results.
 */
export async function processMarketRefunds(
  market_id: string,
  token_address: string,
): Promise<{ total: number; notified: number; submitted: number; failed: number }> {
  const result = { total: 0, notified: 0, submitted: 0, failed: 0 };

  // Validate market exists and is cancelled
  const marketResult = await pool.query(
    'SELECT contract_address, status FROM markets WHERE market_id = $1',
    [market_id],
  );
  if (marketResult.rowCount === 0) {
    throw AppError.notFound(`Market not found: ${market_id}`);
  }
  const { contract_address, status } = marketResult.rows[0];
  if (status !== 'cancelled') {
    throw AppError.badRequest(`Market ${market_id} is not cancelled (status: ${status})`);
  }

  // Get all unique unclaimed bettors
  const { rows: bettors } = await pool.query(
    `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1 AND claimed = FALSE`,
    [market_id],
  );

  result.total = bettors.length;
  if (result.total === 0) return result;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of bettors) {
      const bettor_address = row.bettor_address;

      // Enqueue notification
      await client.query(
        `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [bettor_address, market_id, 'refund_available', 'pending'],
      );
      result.notified++;

      // Attempt on-chain refund (server signs with oracle keypair)
      try {
        const bettorScVal = Address.fromString(bettor_address).toScVal();
        const tokenScVal = Address.fromString(token_address).toScVal();
        await invokeContract(contract_address, 'claim_refund', [bettorScVal, tokenScVal]);
        result.submitted++;
      } catch {
        // Expected — claim_refund requires bettor.require_auth();
        // bettor must claim individually via their own wallet.
        result.failed++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return result;
}
