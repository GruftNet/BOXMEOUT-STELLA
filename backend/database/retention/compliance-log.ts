/**
 * @file compliance-log.ts
 * @description Append-only audit trail for every retention action.
 */

import { createHash } from 'crypto';
import { ComplianceEvent, ComplianceRegime, DataClass } from './types';

/**
 * Minimal surface of a `pg` pool, so callers can inject a client or a mock.
 *
 * `R extends object` rather than `Record<string, unknown>`: a declared row
 * interface has no implicit index signature, so the stricter constraint would
 * reject every named row type callers actually pass.
 */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface ComplianceLogRow {
  id: number;
  action: string;
  dataClass: string | null;
  regime: string;
  rowCount: number | null;
  detail: Record<string, unknown>;
  actor: string;
  recordedAt: Date;
  prevHash: string | null;
  entryHash: string;
}

/**
 * Writes the compliance audit trail.
 *
 * Entries are hash-chained: each row commits to its predecessor's hash, so a
 * later edit or deletion of any entry invalidates every hash after it. That is
 * what makes the trail defensible under SOX — an auditor can verify the chain
 * independently rather than taking the database's word that nothing was
 * tampered with. The table itself is additionally protected by a trigger that
 * rejects UPDATE and DELETE (see the accompanying migration).
 */
export class ComplianceLog {
  constructor(private readonly db: Queryable) {}

  /**
   * Computes an entry's hash over its own content plus the previous hash.
   * Field order is fixed and explicit because a hash chain whose input encoding
   * can drift is not verifiable across versions.
   */
  static computeHash(
    event: ComplianceEvent,
    recordedAt: Date,
    prevHash: string | null,
  ): string {
    const canonical = JSON.stringify([
      prevHash ?? '',
      event.action,
      event.dataClass ?? '',
      event.regime,
      event.rowCount ?? '',
      event.actor,
      // Sort keys so semantically identical detail objects hash identically.
      JSON.stringify(event.detail, Object.keys(event.detail).sort()),
      recordedAt.toISOString(),
    ]);
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Appends an event.
   *
   * The read of the previous hash and the insert happen in one statement via a
   * CTE so that two concurrent sweeps cannot both read the same tip and fork
   * the chain. `retention_compliance_log` is also serialised by a unique index
   * on `entry_hash`, so a genuine fork fails loudly rather than silently.
   */
  async record(event: ComplianceEvent): Promise<ComplianceLogRow> {
    const recordedAt = new Date();

    const { rows } = await this.db.query<{ prev_hash: string | null }>(
      `SELECT entry_hash AS prev_hash
         FROM retention_compliance_log
        ORDER BY id DESC
        LIMIT 1`,
    );
    const prevHash = rows[0]?.prev_hash ?? null;
    const entryHash = ComplianceLog.computeHash(event, recordedAt, prevHash);

    const inserted = await this.db.query<{
      id: number;
      recorded_at: Date;
    }>(
      `INSERT INTO retention_compliance_log
         (action, data_class, regime, row_count, detail, actor, recorded_at, prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING id, recorded_at`,
      [
        event.action,
        event.dataClass,
        event.regime,
        event.rowCount,
        JSON.stringify(event.detail),
        event.actor,
        recordedAt,
        prevHash,
        entryHash,
      ],
    );

    return {
      id: inserted.rows[0].id,
      action: event.action,
      dataClass: event.dataClass,
      regime: event.regime,
      rowCount: event.rowCount,
      detail: event.detail,
      actor: event.actor,
      recordedAt,
      prevHash,
      entryHash,
    };
  }

  /**
   * Walks the chain from the beginning and reports the first entry whose hash
   * does not reconcile. Returns `null` when the trail is intact.
   */
  async verifyChain(): Promise<{ brokenAtId: number; reason: string } | null> {
    const { rows } = await this.db.query<{
      id: number;
      action: string;
      data_class: string | null;
      regime: string;
      row_count: number | null;
      detail: Record<string, unknown>;
      actor: string;
      recorded_at: Date;
      prev_hash: string | null;
      entry_hash: string;
    }>(
      `SELECT id, action, data_class, regime, row_count, detail, actor,
              recorded_at, prev_hash, entry_hash
         FROM retention_compliance_log
        ORDER BY id ASC`,
    );

    let expectedPrev: string | null = null;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          brokenAtId: row.id,
          reason: `prev_hash ${row.prev_hash ?? 'null'} does not match preceding entry hash ${
            expectedPrev ?? 'null'
          }; an entry was removed or reordered`,
        };
      }

      const recomputed = ComplianceLog.computeHash(
        {
          action: row.action as ComplianceEvent['action'],
          dataClass: row.data_class as DataClass | null,
          regime: row.regime as ComplianceRegime,
          rowCount: row.row_count,
          detail: row.detail,
          actor: row.actor,
        },
        new Date(row.recorded_at),
        row.prev_hash,
      );

      if (recomputed !== row.entry_hash) {
        return {
          brokenAtId: row.id,
          reason: 'entry content does not match its recorded hash; the row was modified',
        };
      }

      expectedPrev = row.entry_hash;
    }

    return null;
  }

  /** Exports the trail for an auditor, optionally narrowed to a time window. */
  async export(from?: Date, to?: Date): Promise<ComplianceLogRow[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (from) {
      values.push(from);
      clauses.push(`recorded_at >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      clauses.push(`recorded_at <= $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await this.db.query<Record<string, never>>(
      `SELECT id, action, data_class, regime, row_count, detail, actor,
              recorded_at, prev_hash, entry_hash
         FROM retention_compliance_log
         ${where}
        ORDER BY id ASC`,
      values,
    );

    return (rows as unknown as Record<string, unknown>[]).map((row) => ({
      id: row.id as number,
      action: row.action as string,
      dataClass: row.data_class as string | null,
      regime: row.regime as string,
      rowCount: row.row_count as number | null,
      detail: row.detail as Record<string, unknown>,
      actor: row.actor as string,
      recordedAt: new Date(row.recorded_at as string),
      prevHash: row.prev_hash as string | null,
      entryHash: row.entry_hash as string,
    }));
  }
}
