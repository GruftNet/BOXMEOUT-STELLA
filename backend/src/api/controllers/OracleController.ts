import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../../utils/AppError';
import { validate } from '../middleware/validate';
import * as OracleService from '../../oracle/OracleService';
import { redis } from '../../config/redis';
import { pool } from '../../config/db';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schema for POST /api/oracle/submit body
// ---------------------------------------------------------------------------
const ORACLE_OUTCOMES = ['fighter_a', 'fighter_b', 'draw', 'no_contest'] as const;

const submitOracleResultSchema = z.object({
  match_id: z.string().min(1, 'match_id is required'),
  outcome: z.enum(ORACLE_OUTCOMES, {
    message: 'outcome must be one of: fighter_a, fighter_b, draw, no_contest',
  }),
  reported_at: z
    .string()
    .datetime({ message: 'reported_at must be a valid ISO 8601 datetime string' }),
  signature: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'signature must be a hex-encoded string')
    .min(1, 'signature is required'),
  oracle_address: z
    .string()
    .min(1, 'oracle_address is required'),
});

export const validateSubmitOracleResult = validate(submitOracleResultSchema, 'body');

const RATE_LIMIT_TTL = 60; // seconds

/**
 * POST /api/oracle/submit
 * 1. Verify HMAC-SHA256 signature using ORACLE_HMAC_SECRET
 * 2. Rate-limit: 1 submission per match_id per 60 seconds (Redis)
 * 3. Respond 202 immediately; call OracleService.submitFightResult() async
 */
export async function submitOracleResult(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const hmacSecret = process.env.ORACLE_HMAC_SECRET;
    if (!hmacSecret) {
      return next(new AppError(500, 'ORACLE_HMAC_SECRET is not configured'));
    }

    const { match_id, outcome, reported_at, signature, oracle_address } =
      req.body as z.infer<typeof submitOracleResultSchema>;

    // Step 1 — Verify HMAC-SHA256 signature
    // Canonical message: match_id|outcome|reported_at|oracle_address
    const message = `${match_id}|${outcome}|${reported_at}|${oracle_address}`;
    const expected = createHmac('sha256', hmacSecret).update(message).digest('hex');

    let sigValid = false;
    try {
      sigValid = timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      return next(new AppError(401, 'Invalid HMAC signature'));
    }

    // Step 2 — Rate-limit: 1 submission per match_id per 60 seconds
    const rateLimitKey = `oracle:ratelimit:${match_id}`;
    const existing = await redis.set(rateLimitKey, '1', 'EX', RATE_LIMIT_TTL, 'NX');
    if (existing === null) {
      return next(new AppError(429, `Rate limit exceeded: match_id ${match_id} already submitted within 60 seconds`));
    }

    // Step 3 — Verify oracle is staked in OracleRegistry (reject un-staked reporters)
    const isStaked = await OracleService.verifyOracleIsStaked(oracle_address);
    if (!isStaked) {
      return next(new AppError(403, `Oracle ${oracle_address} has no active stake in OracleRegistry`));
    }

    // Step 4 — Respond 202 immediately
    res.status(202).json({ message: 'Accepted' });

    // Step 5 — Async resolution (fire-and-forget)
    OracleService.submitFightResult(match_id, outcome as OracleService.FightOutcome).catch(
      (err) => {
        // Log but don't crash — response already sent
        console.error({ err, match_id, outcome }, 'submitOracleResult: async submitFightResult failed');
      },
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/oracle/reports/:match_id
 * Returns all oracle reports for a fight.
 */
export async function getOracleReports(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { match_id } = req.params;
    const { rows } = await pool.query(
      `SELECT oracle_address, outcome, reported_at, accepted, tx_hash
         FROM oracle_reports
        WHERE match_id = $1
        ORDER BY reported_at ASC`,
      [match_id],
    );
    res.json({ match_id, reports: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/oracle/leaderboard
 * Returns all registered oracles sorted by reputation_score (descending),
 * with their stake status and slash history from oracle_reports.
 *
 * On-chain reputation and stake are queried via OracleService (best-effort).
 * If the registry is not configured, is_staked defaults to true.
 */
export async function getLeaderboard(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rows } = await pool.query<{
      oracle_address: string;
      total_reports: string;
      accepted_reports: string;
      slash_count: string;
    }>(
      `SELECT
         oracle_address,
         COUNT(*)                                        AS total_reports,
         COUNT(*) FILTER (WHERE accepted = true)        AS accepted_reports,
         COUNT(*) FILTER (WHERE accepted = false)       AS slash_count
       FROM oracle_reports
       GROUP BY oracle_address`,
    );

    // Enrich with on-chain stake status (reputation is managed on-chain)
    const leaderboard = await Promise.all(
      rows.map(async (row) => {
        const is_staked = await OracleService.verifyOracleIsStaked(row.oracle_address).catch(() => false);
        return {
          oracle_address: row.oracle_address,
          total_reports: Number(row.total_reports),
          accepted_reports: Number(row.accepted_reports),
          slash_count: Number(row.slash_count),
          is_staked,
        };
      }),
    );

    // Sort by accepted_reports desc (proxy for on-chain reputation) then total_reports
    leaderboard.sort(
      (a, b) => b.accepted_reports - a.accepted_reports || b.total_reports - a.total_reports,
    );

    res.json({ leaderboard });
  } catch (err) {
    next(err);
  }
}
