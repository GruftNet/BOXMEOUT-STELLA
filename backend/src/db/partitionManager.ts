// ============================================================
// BOXMEOUT — Partition Manager
// Rolling monthly range partitions for bets / blockchain_events
// ============================================================

import type { Pool } from 'pg';

/** Tables converted to declarative range partitions, and the column each is keyed on. */
export const PARTITIONED_TABLES = {
  bets: 'placed_at',
  blockchain_events: 'ledger_close_time',
} as const;

export type PartitionedTable = keyof typeof PARTITIONED_TABLES;

export interface PartitionRange {
  /** Child table name, e.g. `bets_2026_07`. */
  name: string;
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

/**
 * UTC month containing `date`, as a half-open [from, to) range.
 *
 * Partition bounds are always UTC. Deriving them from local time would shift
 * boundaries by the server's offset and leave gaps that route rows to the
 * DEFAULT partition.
 */
export function monthRange(table: PartitionedTable, date: Date): PartitionRange {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const suffix = `${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return { name: `${table}_${suffix}`, from, to };
}

/**
 * Create partitions for the next `monthsAhead` months if they don't exist.
 *
 * Run this on a schedule well ahead of the boundary. Without a partition for
 * the incoming month, rows fall into the DEFAULT partition, which is slow to
 * query and cannot later be split without rewriting it.
 *
 * Returns the partitions that were newly created.
 */
export async function ensureFuturePartitions(
  pool: Pool,
  table: PartitionedTable,
  monthsAhead = 3,
): Promise<PartitionRange[]> {
  const created: PartitionRange[] = [];
  const now = new Date();

  for (let i = 0; i <= monthsAhead; i += 1) {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const range = monthRange(table, target);

    // `CREATE TABLE IF NOT EXISTS` reports nothing useful about whether it
    // actually created anything, so existence is checked first to keep the
    // return value meaningful to callers that log or alert on it.
    const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [
      range.name,
    ]);
    if (rows[0]?.exists) continue;

    // CREATE TABLE ... PARTITION OF takes an ACCESS EXCLUSIVE lock on the
    // parent, so this is deliberately one short statement per month rather
    // than a single long transaction holding the lock across all of them.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${range.name}
         PARTITION OF ${table}
         FOR VALUES FROM ($1) TO ($2)`,
      [range.from.toISOString(), range.to.toISOString()],
    );
    created.push(range);
  }

  return created;
}

/** Partitions currently attached to `table`, oldest bound first. */
export async function listPartitions(pool: Pool, table: PartitionedTable): Promise<string[]> {
  const { rows } = await pool.query<{ child: string }>(
    `SELECT c.relname AS child
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1
      ORDER BY c.relname`,
    [table],
  );
  return rows.map((r) => r.child);
}

/**
 * Detach and drop partitions whose entire range predates the retention window.
 *
 * Detach-then-drop rather than a bare DROP: detaching takes a briefer lock and
 * leaves the data readable as a standalone table if the drop is interrupted.
 * The DEFAULT partition is never dropped.
 */
export async function dropPartitionsOlderThan(
  pool: Pool,
  table: PartitionedTable,
  retentionMonths: number,
): Promise<string[]> {
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retentionMonths, 1));
  const existing = await listPartitions(pool, table);
  const dropped: string[] = [];

  for (const child of existing) {
    if (child === `${table}_default`) continue;

    const match = child.match(/_(\d{4})_(\d{2})$/);
    if (!match) continue;

    const partitionStart = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    if (partitionStart >= cutoff) continue;

    await pool.query(`ALTER TABLE ${table} DETACH PARTITION ${child}`);
    await pool.query(`DROP TABLE ${child}`);
    dropped.push(child);
  }

  if (dropped.length > 0) {
    // The dedup registry is unpartitioned, so it does not shrink when a
    // partition is dropped. Prune it in step or it grows without bound.
    // Safe because a tx_hash whose rows have aged out can no longer be
    // double-inserted against data that still exists.
    await pool.query('DELETE FROM tx_hash_registry WHERE source_table = $1 AND occurred_at < $2', [
      table,
      cutoff.toISOString(),
    ]);
  }

  return dropped;
}

/**
 * Rows sitting in the DEFAULT partition — always a problem worth alerting on.
 *
 * A non-zero count means writes arrived outside every defined range, i.e.
 * `ensureFuturePartitions` stopped running or fell behind.
 */
export async function countDefaultPartitionRows(pool: Pool, table: PartitionedTable): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}_default`);
  return Number(rows[0]?.count ?? 0);
}
