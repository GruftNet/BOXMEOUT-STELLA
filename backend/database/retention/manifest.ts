/**
 * @file manifest.ts
 * @description The searchable index of what has been archived and where.
 */

import { Queryable } from './compliance-log';
import { ArchiveManifestEntry, ArchiveSearchQuery, DataClass } from './types';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface ManifestRow {
  id: number;
  data_class: string;
  object_key: string;
  checksum: string;
  size_bytes: string;
  row_count: number;
  range_start: string;
  range_end: string;
  min_key: string;
  max_key: string;
  archived_at: string;
  deletion_verified_at: string | null;
  storage_class: string;
}

function toEntry(row: ManifestRow): ArchiveManifestEntry {
  return {
    id: row.id,
    dataClass: row.data_class as DataClass,
    objectKey: row.object_key,
    checksum: row.checksum,
    // size_bytes is BIGINT, which node-postgres returns as a string to avoid
    // silent precision loss; parse it explicitly rather than relying on
    // JavaScript coercing it somewhere downstream.
    sizeBytes: Number(row.size_bytes),
    rowCount: row.row_count,
    rangeStart: new Date(row.range_start),
    rangeEnd: new Date(row.range_end),
    minKey: row.min_key,
    maxKey: row.max_key,
    archivedAt: new Date(row.archived_at),
    deletionVerifiedAt: row.deletion_verified_at ? new Date(row.deletion_verified_at) : null,
    storageClass: row.storage_class,
  };
}

export class ArchiveManifest {
  constructor(private readonly db: Queryable) {}

  /**
   * Records an archived batch.
   *
   * Idempotent on `object_key`: a sweep that crashed between writing the object
   * and deleting the rows will recompute the same deterministic key on its next
   * run, and must resume rather than fail or duplicate the entry.
   */
  async record(
    entry: Omit<ArchiveManifestEntry, 'id' | 'archivedAt' | 'deletionVerifiedAt'>,
  ): Promise<ArchiveManifestEntry> {
    const { rows } = await this.db.query<ManifestRow>(
      `INSERT INTO retention_archive_manifest
         (data_class, object_key, checksum, size_bytes, row_count,
          range_start, range_end, min_key, max_key, storage_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (object_key) DO UPDATE
         SET checksum = EXCLUDED.checksum,
             size_bytes = EXCLUDED.size_bytes,
             row_count = EXCLUDED.row_count
       RETURNING *`,
      [
        entry.dataClass,
        entry.objectKey,
        entry.checksum,
        entry.sizeBytes,
        entry.rowCount,
        entry.rangeStart,
        entry.rangeEnd,
        entry.minKey,
        entry.maxKey,
        entry.storageClass,
      ],
    );
    return toEntry(rows[0]);
  }

  async markDeletionVerified(id: number): Promise<void> {
    await this.db.query(
      `UPDATE retention_archive_manifest
          SET deletion_verified_at = NOW()
        WHERE id = $1`,
      [id],
    );
  }

  async findById(id: number): Promise<ArchiveManifestEntry | null> {
    const { rows } = await this.db.query<ManifestRow>(
      `SELECT * FROM retention_archive_manifest WHERE id = $1`,
      [id],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async findByObjectKey(objectKey: string): Promise<ArchiveManifestEntry | null> {
    const { rows } = await this.db.query<ManifestRow>(
      `SELECT * FROM retention_archive_manifest WHERE object_key = $1`,
      [objectKey],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  /**
   * Searches archived batches by class and overlapping time range. This is what
   * makes archived data discoverable without touching cold storage: the caller
   * narrows to a handful of manifests here, then restores only those.
   */
  async search(query: ArchiveSearchQuery): Promise<ArchiveManifestEntry[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (query.dataClass) {
      values.push(query.dataClass);
      clauses.push(`data_class = $${values.length}`);
    }
    // Overlap, not containment: a batch spanning the query window's edge is
    // still relevant to the caller and must not be silently omitted.
    if (query.from) {
      values.push(query.from);
      clauses.push(`range_end >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      clauses.push(`range_start <= $${values.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(query.offset ?? 0);
    const offsetPlaceholder = `$${values.length}`;

    const { rows } = await this.db.query<ManifestRow>(
      `SELECT * FROM retention_archive_manifest
       ${where}
       ORDER BY range_start DESC, id DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values,
    );

    return rows.map(toEntry);
  }

  /** Aggregate archived bytes per class, used to evidence the cost reduction. */
  async storageSummary(): Promise<{ dataClass: DataClass; bytes: number; rows: number }[]> {
    const { rows } = await this.db.query<{
      data_class: string;
      bytes: string;
      rows: string;
    }>(
      `SELECT data_class,
              COALESCE(SUM(size_bytes), 0) AS bytes,
              COALESCE(SUM(row_count), 0)  AS rows
         FROM retention_archive_manifest
        GROUP BY data_class
        ORDER BY data_class`,
    );
    return rows.map((row) => ({
      dataClass: row.data_class as DataClass,
      bytes: Number(row.bytes),
      rows: Number(row.rows),
    }));
  }

  /**
   * Batches archived but never confirmed deleted. These are the dangerous ones:
   * the data exists in both tiers, so the retention promise is not yet kept.
   */
  async unverified(): Promise<ArchiveManifestEntry[]> {
    const { rows } = await this.db.query<ManifestRow>(
      `SELECT * FROM retention_archive_manifest
        WHERE deletion_verified_at IS NULL
        ORDER BY archived_at ASC`,
    );
    return rows.map(toEntry);
  }
}
