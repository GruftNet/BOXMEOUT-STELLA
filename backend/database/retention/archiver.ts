/**
 * @file archiver.ts
 * @description The retention sweep: age out rows, archive them, verify, delete.
 */

import { Anonymizer } from './anonymizer';
import {
  ColdStorageBackend,
  buildObjectKey,
  checksumOf,
  deserializeBatch,
  serializeBatch,
} from './archive-store';
import { ComplianceLog, Queryable } from './compliance-log';
import { ArchiveManifest } from './manifest';
import { PolicyRegistry, cutoffFor } from './policies';
import { ArchiveBatch, RetentionPolicy, SweepResult } from './types';

export interface ArchiverOptions {
  /**
   * Rows per batch. Deliberately small: each batch is one short transaction, and
   * the delete holds row locks only for its duration. Larger batches compress
   * marginally better but lengthen the lock window, which is the thing the
   * "runs without locking" requirement actually cares about.
   */
  batchSize?: number;
  /**
   * Milliseconds to pause between batches, yielding to production traffic. At
   * the default the sweep moves ~2M rows/hour, comfortably inside a weekly
   * maintenance window while staying invisible to foreground queries.
   */
  pauseBetweenBatchesMs?: number;
  /** Safety valve so a misconfigured policy cannot drain a table in one run. */
  maxBatchesPerClass?: number;
  actor?: string;
}

const DEFAULTS = {
  batchSize: 1000,
  pauseBetweenBatchesMs: 50,
  maxBatchesPerClass: 5000,
  actor: 'retention-cron',
};

export class ArchivalError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ArchivalError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms).unref?.();
  });

export class Archiver {
  private readonly opts: Required<ArchiverOptions>;

  constructor(
    private readonly db: Queryable,
    private readonly storage: ColdStorageBackend,
    private readonly manifest: ArchiveManifest,
    private readonly complianceLog: ComplianceLog,
    private readonly anonymizer: Anonymizer,
    private readonly registry: PolicyRegistry,
    options: ArchiverOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Runs a full sweep across every sweepable policy.
   *
   * One failing data class does not abort the others: a misconfigured policy on
   * a low-value table should not stop the SOX-governed classes from being swept
   * on schedule. Failures are collected and surfaced in the result.
   */
  async sweepAll(now: Date = new Date()): Promise<SweepResult[]> {
    const results: SweepResult[] = [];
    for (const policy of this.registry.sweepable()) {
      try {
        results.push(await this.sweep(policy, now));
      } catch (err) {
        await this.complianceLog.record({
          action: 'sweep_failed',
          dataClass: policy.dataClass,
          regime: policy.regime,
          rowCount: null,
          detail: { error: err instanceof Error ? err.message : String(err) },
          actor: this.opts.actor,
        });
        results.push({
          dataClass: policy.dataClass,
          batchesArchived: 0,
          rowsArchived: 0,
          rowsAnonymized: 0,
          rowsDeleted: 0,
          bytesStored: 0,
          unverifiedBatches: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
    return results;
  }

  async sweep(policy: RetentionPolicy, now: Date = new Date()): Promise<SweepResult> {
    const cutoff = cutoffFor(policy, now);
    const result: SweepResult = {
      dataClass: policy.dataClass,
      batchesArchived: 0,
      rowsArchived: 0,
      rowsAnonymized: 0,
      rowsDeleted: 0,
      bytesStored: 0,
      unverifiedBatches: 0,
      errors: [],
    };

    await this.complianceLog.record({
      action: 'sweep_started',
      dataClass: policy.dataClass,
      regime: policy.regime,
      rowCount: null,
      detail: { cutoff: cutoff.toISOString(), action: policy.action },
      actor: this.opts.actor,
    });

    if (policy.action === 'anonymize_in_place') {
      result.rowsAnonymized = await this.anonymizeInPlace(policy, cutoff);
    } else {
      await this.archiveThenDelete(policy, cutoff, result);
    }

    await this.complianceLog.record({
      action: 'sweep_completed',
      dataClass: policy.dataClass,
      regime: policy.regime,
      rowCount: result.rowsDeleted + result.rowsAnonymized,
      detail: {
        cutoff: cutoff.toISOString(),
        batchesArchived: result.batchesArchived,
        rowsArchived: result.rowsArchived,
        bytesStored: result.bytesStored,
        unverifiedBatches: result.unverifiedBatches,
      },
      actor: this.opts.actor,
    });

    return result;
  }

  /**
   * Reads the next batch of expired rows.
   *
   * Keyset pagination on the primary key, not OFFSET: the sweep deletes as it
   * goes, so an offset would skip rows as the result set shifts underneath it.
   * Ordering by key also makes each batch a contiguous range, which is what
   * lets deletion be verified with a single bounded count afterwards.
   */
  private async readBatch(
    policy: RetentionPolicy,
    cutoff: Date,
    afterKey: string | null,
  ): Promise<ArchiveBatch | null> {
    const keyClause = afterKey !== null ? `AND ${policy.keyColumn} > $3` : '';
    const values: unknown[] = [cutoff, this.opts.batchSize];
    if (afterKey !== null) {
      values.push(afterKey);
    }

    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM ${policy.table}
        WHERE ${policy.timestampColumn} < $1
          ${keyClause}
        ORDER BY ${policy.keyColumn} ASC
        LIMIT $2`,
      values,
    );

    if (rows.length === 0) {
      return null;
    }

    const timestamps = rows
      .map((row) => new Date(row[policy.timestampColumn] as string).getTime())
      .filter((t) => !Number.isNaN(t));

    return {
      dataClass: policy.dataClass,
      rows,
      minKey: String(rows[0][policy.keyColumn]),
      maxKey: String(rows[rows.length - 1][policy.keyColumn]),
      rangeStart: new Date(Math.min(...timestamps)),
      rangeEnd: new Date(Math.max(...timestamps)),
    };
  }

  /**
   * Archives and deletes expired rows for one policy.
   *
   * The ordering here is the whole safety argument, and it is deliberately
   * paranoid in one direction: every step is durable before the destructive one
   * runs, so a crash at any point leaves data duplicated (recoverable) rather
   * than lost (not).
   *
   *   1. read batch            - no locks held
   *   2. scrub PII             - the archived copy is never re-identifiable
   *   3. write to cold storage - durable, atomic rename / S3 put
   *   4. read back + checksum  - proves the object is intact and retrievable
   *   5. record manifest       - idempotent on the deterministic object key
   *   6. delete source rows    - short transaction, bounded by primary key
   *   7. verify deletion       - count must be zero before the batch is closed
   */
  private async archiveThenDelete(
    policy: RetentionPolicy,
    cutoff: Date,
    result: SweepResult,
  ): Promise<void> {
    let afterKey: string | null = null;

    for (let i = 0; i < this.opts.maxBatchesPerClass; i += 1) {
      const batch = await this.readBatch(policy, cutoff, afterKey);
      if (!batch) {
        return;
      }
      afterKey = batch.maxKey;

      const scrubbed: ArchiveBatch = {
        ...batch,
        rows: this.anonymizer.scrubRows(batch.rows, policy),
      };

      const objectKey = buildObjectKey(scrubbed);
      const payload = serializeBatch(scrubbed);
      const checksum = checksumOf(payload);

      await this.storage.put(objectKey, payload);

      // Read back before deleting anything. An object that cannot be retrieved
      // and verified is not an archive, and deleting against it would be data
      // loss dressed up as compliance.
      const readBack = await this.storage.get(objectKey);
      if (checksumOf(readBack) !== checksum) {
        throw new ArchivalError(
          `checksum mismatch for ${objectKey}; refusing to delete source rows`,
        );
      }
      if (deserializeBatch(readBack).length !== scrubbed.rows.length) {
        throw new ArchivalError(
          `row count mismatch for ${objectKey}; refusing to delete source rows`,
        );
      }

      const entry = await this.manifest.record({
        dataClass: policy.dataClass,
        objectKey,
        checksum,
        sizeBytes: payload.byteLength,
        rowCount: scrubbed.rows.length,
        rangeStart: scrubbed.rangeStart,
        rangeEnd: scrubbed.rangeEnd,
        minKey: scrubbed.minKey,
        maxKey: scrubbed.maxKey,
        storageClass: this.storage.storageClass,
      });

      await this.complianceLog.record({
        action: 'archive_written',
        dataClass: policy.dataClass,
        regime: policy.regime,
        rowCount: scrubbed.rows.length,
        detail: { objectKey, checksum, sizeBytes: payload.byteLength, manifestId: entry.id },
        actor: this.opts.actor,
      });

      const deleted = await this.deleteBatch(policy, batch);
      result.rowsDeleted += deleted;

      const verified = await this.verifyDeletion(policy, batch, cutoff);
      if (verified) {
        await this.manifest.markDeletionVerified(entry.id);
        await this.complianceLog.record({
          action: 'deletion_verified',
          dataClass: policy.dataClass,
          regime: policy.regime,
          rowCount: deleted,
          detail: { manifestId: entry.id, minKey: batch.minKey, maxKey: batch.maxKey },
          actor: this.opts.actor,
        });
      } else {
        // Leave the manifest unverified rather than throwing: the archive is
        // sound, the source is not yet provably gone, and `manifest.unverified()`
        // is the alert surface for exactly this.
        result.unverifiedBatches += 1;
        result.errors.push(
          `deletion not verified for manifest ${entry.id} (${batch.minKey}-${batch.maxKey})`,
        );
      }

      result.batchesArchived += 1;
      result.rowsArchived += scrubbed.rows.length;
      result.bytesStored += payload.byteLength;

      await sleep(this.opts.pauseBetweenBatchesMs);
    }
  }

  /**
   * Deletes one batch by primary-key range.
   *
   * Bounded by the key range actually archived, and re-asserting the timestamp
   * predicate, so a row that was updated to a newer timestamp between the read
   * and the delete is left alone rather than deleted on stale evidence.
   *
   * The bound is inclusive of `rangeEnd`: that timestamp belongs to a row this
   * batch just archived, and an exclusive bound would spare the newest row of
   * every batch — leaving it duplicated in both tiers forever, since the next
   * batch's keyset cursor has already moved past it.
   */
  private async deleteBatch(policy: RetentionPolicy, batch: ArchiveBatch): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM ${policy.table}
        WHERE ${policy.keyColumn} >= $1
          AND ${policy.keyColumn} <= $2
          AND ${policy.timestampColumn} <= $3`,
      [batch.minKey, batch.maxKey, batch.rangeEnd.toISOString()],
    );

    await this.complianceLog.record({
      action: 'rows_deleted',
      dataClass: policy.dataClass,
      regime: policy.regime,
      rowCount: rowCount ?? 0,
      detail: { minKey: batch.minKey, maxKey: batch.maxKey },
      actor: this.opts.actor,
    });

    return rowCount ?? 0;
  }

  /** Confirms no expired rows survive in the batch's key range. */
  private async verifyDeletion(
    policy: RetentionPolicy,
    batch: ArchiveBatch,
    cutoff: Date,
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ remaining: string }>(
      `SELECT COUNT(*)::text AS remaining
         FROM ${policy.table}
        WHERE ${policy.keyColumn} >= $1
          AND ${policy.keyColumn} <= $2
          AND ${policy.timestampColumn} < $3`,
      [batch.minKey, batch.maxKey, cutoff],
    );
    return Number(rows[0]?.remaining ?? '0') === 0;
  }

  /**
   * Scrubs PII in place for policies that keep the row.
   *
   * Each row is updated individually because pseudonymised values are computed
   * in the application (the HMAC key must not reach the database). Batched into
   * bounded key ranges so the sweep still never holds a long transaction.
   */
  private async anonymizeInPlace(policy: RetentionPolicy, cutoff: Date): Promise<number> {
    let afterKey: string | null = null;
    let total = 0;

    for (let i = 0; i < this.opts.maxBatchesPerClass; i += 1) {
      // Only rows not already scrubbed, so repeated sweeps converge instead of
      // rewriting the same rows every week.
      const alreadyScrubbed = policy.piiColumns
        .map((c) => `${c} IS NOT NULL AND ${c} NOT LIKE 'anon\\_%' AND ${c} <> '[redacted]'`)
        .join(' OR ');

      // Annotated because `afterKey` is assigned from the rows this clause
      // helps select, which TypeScript would otherwise see as circular.
      const keyClause: string = afterKey !== null ? `AND ${policy.keyColumn} > $3` : '';
      const values: unknown[] = [cutoff, this.opts.batchSize];
      if (afterKey !== null) {
        values.push(afterKey);
      }

      const { rows } = await this.db.query<Record<string, unknown>>(
        `SELECT * FROM ${policy.table}
          WHERE ${policy.timestampColumn} < $1
            AND (${alreadyScrubbed})
            ${keyClause}
          ORDER BY ${policy.keyColumn} ASC
          LIMIT $2`,
        values,
      );

      if (rows.length === 0) {
        break;
      }
      afterKey = String(rows[rows.length - 1][policy.keyColumn]);

      for (const row of rows) {
        const scrubbed = this.anonymizer.scrubRow(row, policy);
        const assignments = policy.piiColumns.map((c, idx) => `${c} = $${idx + 2}`).join(', ');
        await this.db.query(
          `UPDATE ${policy.table} SET ${assignments} WHERE ${policy.keyColumn} = $1`,
          [row[policy.keyColumn], ...policy.piiColumns.map((c) => scrubbed[c])],
        );
        total += 1;
      }

      await this.complianceLog.record({
        action: 'rows_anonymized',
        dataClass: policy.dataClass,
        regime: policy.regime,
        rowCount: rows.length,
        detail: { columns: policy.piiColumns, throughKey: afterKey },
        actor: this.opts.actor,
      });

      await sleep(this.opts.pauseBetweenBatchesMs);
    }

    return total;
  }
}
