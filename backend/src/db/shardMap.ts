// ============================================================
// BOXMEOUT — Shard Map
// Slot-based key routing and the shard registry
// ============================================================

import { createHash } from 'crypto';
import type { Pool } from 'pg';

/**
 * Fixed slot space, Redis-Cluster style.
 *
 * Keys hash to a slot, and slots — not keys — are assigned to shards. This is
 * what makes rebalancing tractable: moving a slot range moves a known set of
 * rows without rehashing anything else. The count is fixed forever; changing
 * it relocates every key at once.
 */
export const SLOT_COUNT = 4096;

export type ShardStatus = 'active' | 'draining' | 'offline';

export interface ShardDescriptor {
  shardKey: string;
  /** Env var holding this shard's connection string; the DSN itself is never stored in the DB. */
  dsnEnvVar: string;
  slotStart: number;
  /** Exclusive. */
  slotEnd: number;
  status: ShardStatus;
  healthy: boolean;
  lastHealthCheckAt: Date | null;
}

/**
 * Which shard owns a given market.
 *
 * `market_id` is the shard key for every co-located table: a market and its
 * bets must live together or the hot read path (market detail + its bets)
 * becomes a cross-shard join. Never shard bets by bettor_address for this
 * reason.
 */
export function slotForKey(key: string): number {
  const digest = createHash('sha1').update(key).digest();
  return digest.readUInt32BE(0) % SLOT_COUNT;
}

/** Load the registry. Callers should cache this; it changes only on rebalance. */
export async function loadShardMap(pool: Pool): Promise<ShardDescriptor[]> {
  const { rows } = await pool.query<{
    shard_key: string;
    dsn_env_var: string;
    slot_start: number;
    slot_end: number;
    status: ShardStatus;
    healthy: boolean;
    last_health_check_at: Date | null;
  }>(
    `SELECT shard_key, dsn_env_var, slot_start, slot_end, status, healthy, last_health_check_at
       FROM shard_map
      ORDER BY slot_start`,
  );

  return rows.map((r) => ({
    shardKey: r.shard_key,
    dsnEnvVar: r.dsn_env_var,
    slotStart: r.slot_start,
    slotEnd: r.slot_end,
    status: r.status,
    healthy: r.healthy,
    lastHealthCheckAt: r.last_health_check_at,
  }));
}

/**
 * Assert the map covers [0, SLOT_COUNT) exactly once.
 *
 * A gap silently drops writes and an overlap sends the same key to two
 * shards, so this runs at startup and after any rebalance rather than being
 * left to discovery in production.
 */
export function validateShardMap(shards: ShardDescriptor[]): void {
  const ordered = [...shards].sort((a, b) => a.slotStart - b.slotStart);
  let expected = 0;

  for (const shard of ordered) {
    if (shard.slotStart !== expected) {
      throw new Error(
        `shard map is not contiguous: expected slot ${expected} at '${shard.shardKey}', got ${shard.slotStart}`,
      );
    }
    expected = shard.slotEnd;
  }

  if (expected !== SLOT_COUNT) {
    throw new Error(`shard map covers ${expected} of ${SLOT_COUNT} slots`);
  }
}

/** Resolve a key to its owning shard. Throws if the map has a hole at that slot. */
export function resolveShard(shards: ShardDescriptor[], key: string): ShardDescriptor {
  const slot = slotForKey(key);
  const shard = shards.find((s) => slot >= s.slotStart && slot < s.slotEnd);

  if (!shard) {
    throw new Error(`no shard owns slot ${slot} (key '${key}')`);
  }
  return shard;
}

/**
 * Slot ranges to move to bring the map toward even ownership.
 *
 * Returns proposals only — it does not move data. Executing a move means
 * copying rows, double-writing during cutover, then flipping ownership, which
 * belongs in an operator-driven job rather than an automatic one.
 */
export function planRebalance(shards: ShardDescriptor[]): Array<{ from: string; to: string; slots: number }> {
  const active = shards.filter((s) => s.status === 'active');
  if (active.length < 2) return [];

  const target = Math.floor(SLOT_COUNT / active.length);
  const overloaded = active
    .map((s) => ({ shard: s, excess: s.slotEnd - s.slotStart - target }))
    .filter((s) => s.excess > 0)
    .sort((a, b) => b.excess - a.excess);
  const underloaded = active
    .map((s) => ({ shard: s, deficit: target - (s.slotEnd - s.slotStart) }))
    .filter((s) => s.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  const moves: Array<{ from: string; to: string; slots: number }> = [];

  for (const donor of overloaded) {
    for (const recipient of underloaded) {
      if (donor.excess === 0) break;
      if (recipient.deficit === 0) continue;

      const slots = Math.min(donor.excess, recipient.deficit);
      moves.push({ from: donor.shard.shardKey, to: recipient.shard.shardKey, slots });
      donor.excess -= slots;
      recipient.deficit -= slots;
    }
  }

  return moves;
}
