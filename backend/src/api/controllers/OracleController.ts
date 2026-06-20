import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../../utils/AppError';
import { validate } from '../middleware/validate';
import * as OracleService from '../../oracle/OracleService';
import { redis } from '../../config/redis';
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

    // Step 3 — Respond 202 immediately
    res.status(202).json({ message: 'Accepted' });

    // Step 4 — Async resolution (fire-and-forget)
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
  _req: Request,
  _res: Response,
): Promise<void> {
  // TODO: implement
}
