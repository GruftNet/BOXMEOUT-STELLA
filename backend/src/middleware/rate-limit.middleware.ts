/**
 * @file rate-limit.middleware.ts
 * @description Token-bucket rate limiting middleware.
 *
 * ## Design
 * A Redis counter tracks request counts within a sliding window (fixed-window
 * approximation via TTL). The middleware:
 *  - Assigns a cache key based on `keyBy` — either the caller's IP or their
 *    authenticated user ID.
 *  - Supports per-endpoint limits via the `EndpointLimit` registry.
 *  - Enforces per-user tier multipliers (basic 1× → elite 10×).
 *  - Grants burst capacity (2× the effective limit) for short windows.
 *  - Honours a static bypass list so premium/internal callers are never throttled.
 *  - Emits standard rate-limit response headers on every request.
 *  - Logs every throttled request for audit trail purposes.
 */

import type { Request, Response, NextFunction } from 'express';
import { redis } from '../services/cache.service';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** User tiers, ordered by privilege. */
export type UserTier = 'basic' | 'standard' | 'premium' | 'elite';

/** Request multipliers per tier (requests per window). */
export const TIER_MULTIPLIERS: Record<UserTier, number> = {
  basic:    1,    //  1 000 req/min at base rate
  standard: 2,    //  2 000 req/min
  premium:  5,    //  5 000 req/min — bypass flag also set
  elite:    10,   // 10 000 req/min — bypass flag also set
};

/** Tiers whose holders bypass rate limiting entirely. */
export const BYPASS_TIERS = new Set<UserTier>(['premium', 'elite']);

/** Static list of IP addresses or user IDs that always bypass rate limits. */
export const BYPASS_LIST: ReadonlySet<string> = new Set(
  (process.env.RATE_LIMIT_BYPASS_LIST ?? '').split(',').filter(Boolean),
);

/** Burst window in milliseconds — 2× limit allowed for this duration. */
const BURST_WINDOW_MS = 10_000; // 10 seconds

export interface RateLimitOptions {
  /** Window duration in milliseconds — e.g. 60_000 for 1 minute. */
  windowMs: number;
  /** Maximum requests per window at base (tier = basic) rate. */
  max: number;
  /** How to derive the throttle key: 'ip' or 'userId'. */
  keyBy: 'ip' | 'userId';
  /**
   * When true the effective limit is doubled (burst mode).
   * Typically applied to short-lived burst windows at the route level.
   */
  burst?: boolean;
}

// ─── Per-endpoint limit registry ─────────────────────────────────────────────

/**
 * Well-known per-endpoint defaults.
 * Routes can override by calling `rateLimit()` with explicit options.
 */
export const ENDPOINT_LIMITS: Record<string, Pick<RateLimitOptions, 'windowMs' | 'max'>> = {
  '/markets':      { windowMs: 60_000,  max: 100  }, // 100/min
  '/orders':       { windowMs:  1_000,  max: 10   }, // 10/sec
  '/auth/login':   { windowMs: 60_000,  max: 10   }, // strict
  '/auth/register':{ windowMs: 60_000,  max: 5    },
};

// ─── Extended request shape ───────────────────────────────────────────────────

interface AuthenticatedUser {
  id: string;
  tier?: UserTier;
}

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

// ─── Core factory ─────────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that enforces a token-bucket rate limit.
 *
 * @example
 * // Global: 1 000 req/min per IP
 * app.use(rateLimit({ windowMs: 60_000, max: 1_000, keyBy: 'ip' }));
 *
 * // Per-route override with burst
 * router.post('/orders', rateLimit({ windowMs: 1_000, max: 10, keyBy: 'userId', burst: true }), handler);
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyBy, burst = false } = options;
  const windowSecs = Math.ceil(windowMs / 1_000);

  return async function rateLimitMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // ── 1. Derive the throttle identifier ──────────────────────────────────
    const identity =
      keyBy === 'userId' && req.user?.id
        ? req.user.id
        : (req.ip ?? 'unknown');

    // ── 2. Check static bypass list ────────────────────────────────────────
    if (BYPASS_LIST.has(identity)) {
      setHeaders(res, max, max, windowSecs);
      next();
      return;
    }

    // ── 3. Check tier-based bypass ─────────────────────────────────────────
    const tier: UserTier = req.user?.tier ?? 'basic';
    if (BYPASS_TIERS.has(tier)) {
      setHeaders(res, max, max, windowSecs);
      next();
      return;
    }

    // ── 4. Compute effective limit ──────────────────────────────────────────
    const tierMultiplier = TIER_MULTIPLIERS[tier];
    const effectiveMax = burst
      ? max * tierMultiplier * 2     // burst: 2× tier limit
      : max * tierMultiplier;

    // ── 5. Build Redis key ──────────────────────────────────────────────────
    const key = `rl:${req.path}:${identity}`;

    // ── 6. Atomically increment and set TTL (on first hit) ──────────────────
    const count = await redis.incr(key);

    if (count === 1) {
      // First request in window — set expiry
      await redis.expire(key, windowSecs);
    }

    // ── 7. Read remaining TTL for headers ───────────────────────────────────
    const ttl = await redis.ttl(key);

    // ── 8. Enforce limit ────────────────────────────────────────────────────
    setHeaders(res, effectiveMax, Math.max(effectiveMax - count, 0), ttl);

    if (count > effectiveMax) {
      // Audit log
      logger.warn({
        event:      'rate_limit_exceeded',
        identity,
        tier,
        path:       req.path,
        count,
        effectiveMax,
        retryAfter: ttl,
      });

      res.set('Retry-After', String(ttl));
      next(new AppError(429, 'Too Many Requests'));
      return;
    }

    next();
  };
}

// ─── Burst-window factory convenience wrapper ─────────────────────────────────

/**
 * Returns a burst-mode middleware: 2× the given `max` is allowed for the first
 * `burstWindowMs` milliseconds (defaults to 10 s), then normal limits apply.
 *
 * Typical usage:
 *   router.get('/markets', burstLimit({ windowMs: 60_000, max: 100, keyBy: 'userId' }), handler);
 */
export function burstLimit(options: Omit<RateLimitOptions, 'burst'>) {
  return rateLimit({ ...options, burst: true });
}

// ─── Per-endpoint factory ─────────────────────────────────────────────────────

/**
 * Returns a rate-limit middleware pre-configured for a well-known endpoint.
 * Falls back to a sensible default (1 000/min per IP) if the path is unknown.
 */
export function endpointLimit(path: string, keyBy: 'ip' | 'userId' = 'ip') {
  const cfg = ENDPOINT_LIMITS[path] ?? { windowMs: 60_000, max: 1_000 };
  return rateLimit({ ...cfg, keyBy });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetSecs: number,
): void {
  res.set({
    'X-RateLimit-Limit':     String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset':     String(Math.floor(Date.now() / 1_000) + resetSecs),
  });
}
