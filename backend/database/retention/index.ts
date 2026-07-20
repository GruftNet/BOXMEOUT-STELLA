/**
 * @file index.ts
 * @description Public surface of the data retention subsystem.
 *
 * Callers should import from here rather than reaching into individual modules,
 * so the internal layout can change without rippling through the application.
 */

export * from './types';
export { DEFAULT_POLICIES, PolicyRegistry, PolicyValidationError, cutoffFor, validatePolicy } from './policies';
export { PolicyStore } from './policy-store';
export { Anonymizer, AnonymizerConfigError, REDACTED, pseudonymize } from './anonymizer';
export {
  ColdStorageBackend,
  ColdStorageError,
  FilesystemColdStorage,
  S3GlacierColdStorage,
  S3GlacierConfig,
  buildObjectKey,
  checksumOf,
  deserializeBatch,
  serializeBatch,
} from './archive-store';
export { ArchiveManifest } from './manifest';
export { ComplianceLog, ComplianceLogRow, Queryable } from './compliance-log';
export { Archiver, ArchivalError, ArchiverOptions } from './archiver';
export { RestoreError, RestoreService } from './restore';
export {
  AlertSeverity,
  ClassHealth,
  RetentionAlert,
  RetentionHealth,
  RetentionMonitor,
} from './monitor';
