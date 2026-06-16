import { pool } from '../config/db';

export type BreakerTriggerType = 'warn' | 'lock' | 'cap' | 'platform_exposure';

export interface CircuitBreakerInput {
  market_id: string;
  trigger_type: BreakerTriggerType;
  imbalance_ratio: number;
  total_pool_xlm: number;
}

export interface CircuitBreakerRow {
  id: number;
  market_id: string;
  trigger_type: string;
  imbalance_ratio: string;
  total_pool_xlm: string;
  triggered_at: Date;
  resolved_at: Date | null;
}

/**
 * Insert a new circuit breaker event.
 * The DB has a partial unique index on (market_id, trigger_type) WHERE resolved_at IS NULL,
 * so a duplicate active breaker yields a unique-violation we silently ignore.
 */
export async function recordBreaker(input: CircuitBreakerInput): Promise<CircuitBreakerRow | null> {
  try {
    const result = await pool.query<CircuitBreakerRow>(
      `INSERT INTO circuit_breaker_events
         (market_id, trigger_type, imbalance_ratio, total_pool_xlm)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.market_id, input.trigger_type, input.imbalance_ratio, input.total_pool_xlm],
    );
    return result.rows[0] ?? null;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      return null;
    }
    throw err;
  }
}

/** Return the most recent unresolved breaker for a market + trigger_type, or null. */
export async function getUnresolvedBreaker(
  market_id: string,
  trigger_type: string,
): Promise<CircuitBreakerRow | null> {
  const result = await pool.query<CircuitBreakerRow>(
    `SELECT * FROM circuit_breaker_events
     WHERE market_id = $1
       AND trigger_type = $2
       AND resolved_at IS NULL
     ORDER BY triggered_at DESC
     LIMIT 1`,
    [market_id, trigger_type],
  );
  return result.rows[0] ?? null;
}

/** Mark a breaker resolved (used when an operator manually unlocks a market). */
export async function resolveBreaker(id: number): Promise<void> {
  await pool.query(
    `UPDATE circuit_breaker_events SET resolved_at = NOW() WHERE id = $1`,
    [id],
  );
}

/** Return the most recent N breaker events across all markets (for the admin dashboard). */
export async function getRecentBreakers(limit = 10): Promise<CircuitBreakerRow[]> {
  const result = await pool.query<CircuitBreakerRow>(
    `SELECT * FROM circuit_breaker_events ORDER BY triggered_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}
