/**
 * @file types.ts
 * @description Shared types for the data retention, archival and purge subsystem.
 */

/**
 * Logical classes of data the platform retains. Each class maps to exactly one
 * retention policy so that a row's fate is never ambiguous.
 */
export type DataClass =
  | 'blockchain_events'
  | 'bets'
  | 'oracle_reports'
  | 'notification_jobs'
  | 'disputes'
  | 'markets';

/** Regulatory regimes that constrain how long a data class must be kept. */
export type ComplianceRegime = 'GDPR' | 'SOX' | 'NONE';

/**
 * What happens to a row once it passes its retention window.
 *
 * - `archive_then_delete`: copied to cold storage, verified, then removed.
 * - `anonymize_in_place`: PII columns are scrubbed but the row survives, used
 *   where an aggregate must stay queryable but the subject must not be
 *   re-identifiable (GDPR Art. 17 with a legitimate analytics interest).
 * - `retain_forever`: never purged; used for records under a SOX obligation
 *   that outlives the platform's own retention ceiling.
 */
export type DisposalAction = 'archive_then_delete' | 'anonymize_in_place' | 'retain_forever';

export interface RetentionPolicy {
  /** The data class this policy governs. Unique across the registry. */
  dataClass: DataClass;
  /** Physical table the policy operates on. */
  table: string;
  /**
   * Timestamp column used to age rows. Must be `TIMESTAMPTZ NOT NULL` so that
   * every row has a deterministic age; nullable columns would let rows escape
   * the sweep forever.
   */
  timestampColumn: string;
  /** Primary key column, used for keyset pagination during the sweep. */
  keyColumn: string;
  /** Age in days beyond which a row is eligible for disposal. 30d - 7y. */
  retentionDays: number;
  action: DisposalAction;
  regime: ComplianceRegime;
  /**
   * Columns holding personal data. Scrubbed by the anonymizer before deletion
   * and before any copy is written to cold storage.
   */
  piiColumns: string[];
  /** Human-readable justification, surfaced in compliance exports. */
  rationale: string;
}

/** Retention windows are bounded to a legally defensible range. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365 * 7;

export interface ArchiveObject {
  /** Storage-backend key, e.g. an S3 object key. */
  key: string;
  /** SHA-256 of the serialized payload, used to verify integrity on restore. */
  checksum: string;
  /** Byte length of the serialized payload as stored. */
  sizeBytes: number;
}

export interface ArchiveManifestEntry {
  id: number;
  dataClass: DataClass;
  objectKey: string;
  checksum: string;
  sizeBytes: number;
  rowCount: number;
  /** Inclusive lower bound of the archived rows' timestamp range. */
  rangeStart: Date;
  /** Inclusive upper bound of the archived rows' timestamp range. */
  rangeEnd: Date;
  /** Lowest and highest primary key in the batch, for point lookups. */
  minKey: string;
  maxKey: string;
  archivedAt: Date;
  /** Set once the source rows have been confirmed deleted. */
  deletionVerifiedAt: Date | null;
  storageClass: string;
}

/** A batch of rows selected for disposal, plus the bounds that identified it. */
export interface ArchiveBatch {
  dataClass: DataClass;
  rows: Record<string, unknown>[];
  minKey: string;
  maxKey: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface SweepResult {
  dataClass: DataClass;
  batchesArchived: number;
  rowsArchived: number;
  rowsAnonymized: number;
  rowsDeleted: number;
  bytesStored: number;
  /** Batches that were archived but whose deletion could not be verified. */
  unverifiedBatches: number;
  errors: string[];
}

/** Action verbs recorded in the immutable compliance log. */
export type ComplianceAction =
  | 'policy_created'
  | 'policy_updated'
  | 'archive_written'
  | 'archive_verified'
  | 'rows_anonymized'
  | 'rows_deleted'
  | 'deletion_verified'
  | 'restore_requested'
  | 'restore_completed'
  | 'sweep_started'
  | 'sweep_completed'
  | 'sweep_failed';

export interface ComplianceEvent {
  action: ComplianceAction;
  dataClass: DataClass | null;
  regime: ComplianceRegime;
  /** Number of rows affected, where the action operates on rows. */
  rowCount: number | null;
  /** Free-form structured detail; must never contain raw PII. */
  detail: Record<string, unknown>;
  /** Operator or system component that initiated the action. */
  actor: string;
}

export interface ArchiveSearchQuery {
  dataClass?: DataClass;
  /** Match manifests whose archived range overlaps [from, to]. */
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface RestoreRequest {
  manifestId: number;
  actor: string;
  /** When set, only rows whose key falls in this range are returned. */
  keyRange?: { min: string; max: string };
}

export interface RestoreResult {
  manifestId: number;
  dataClass: DataClass;
  rows: Record<string, unknown>[];
  /** Wall-clock milliseconds the restore took, for the < 1 hour SLO. */
  durationMs: number;
  checksumVerified: boolean;
}
