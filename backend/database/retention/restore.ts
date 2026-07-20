/**
 * @file restore.ts
 * @description Retrieval of archived batches from cold storage.
 */

import { ColdStorageBackend, checksumOf, deserializeBatch } from './archive-store';
import { ComplianceLog } from './compliance-log';
import { ArchiveManifest } from './manifest';
import { PolicyRegistry } from './policies';
import { RestoreRequest, RestoreResult } from './types';

export class RestoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** The SLO this service is held to, in milliseconds. */
export const RESTORE_SLO_MS = 60 * 60 * 1000;

export class RestoreService {
  constructor(
    private readonly storage: ColdStorageBackend,
    private readonly manifest: ArchiveManifest,
    private readonly complianceLog: ComplianceLog,
    private readonly registry: PolicyRegistry,
  ) {}

  /**
   * Restores one archived batch into memory.
   *
   * Returns rows rather than writing them back to the source table: a restore
   * is almost always an audit or investigation read, and re-inserting would
   * resurrect rows the retention policy just promised were purged. Callers that
   * genuinely need reinstatement should do so explicitly with their own audit
   * trail.
   */
  async restore(request: RestoreRequest): Promise<RestoreResult> {
    const startedAt = Date.now();

    const entry = await this.manifest.findById(request.manifestId);
    if (!entry) {
      throw new RestoreError(`no archive manifest with id ${request.manifestId}`);
    }

    const policy = this.registry.get(entry.dataClass);

    await this.complianceLog.record({
      action: 'restore_requested',
      dataClass: entry.dataClass,
      regime: policy.regime,
      rowCount: entry.rowCount,
      detail: { manifestId: entry.id, objectKey: entry.objectKey },
      actor: request.actor,
    });

    let payload: Buffer;
    try {
      payload = await this.storage.get(entry.objectKey);
    } catch (err) {
      throw new RestoreError(
        `archive object ${entry.objectKey} could not be retrieved from ${entry.storageClass}`,
        err,
      );
    }

    const checksumVerified = checksumOf(payload) === entry.checksum;
    if (!checksumVerified) {
      // Surfaced rather than thrown so an operator can still inspect a
      // corrupted archive, but never silently: the compliance log records that
      // this restore produced unverified data.
      await this.complianceLog.record({
        action: 'restore_completed',
        dataClass: entry.dataClass,
        regime: policy.regime,
        rowCount: 0,
        detail: {
          manifestId: entry.id,
          checksumVerified: false,
          expected: entry.checksum,
          actual: checksumOf(payload),
        },
        actor: request.actor,
      });
      throw new RestoreError(
        `checksum mismatch restoring ${entry.objectKey}; archive object is corrupt`,
      );
    }

    let rows = deserializeBatch(payload);

    if (request.keyRange) {
      const { min, max } = request.keyRange;
      rows = rows.filter((row) => {
        const key = String(row[policy.keyColumn]);
        return key >= min && key <= max;
      });
    }

    const durationMs = Date.now() - startedAt;

    await this.complianceLog.record({
      action: 'restore_completed',
      dataClass: entry.dataClass,
      regime: policy.regime,
      rowCount: rows.length,
      detail: { manifestId: entry.id, durationMs, checksumVerified: true },
      actor: request.actor,
    });

    return { manifestId: entry.id, dataClass: entry.dataClass, rows, durationMs, checksumVerified };
  }

  /**
   * Restores every batch overlapping a time window for one data class.
   *
   * Sequential rather than concurrent: a wide window can match hundreds of
   * manifests, and firing them all at once would exhaust the storage backend's
   * connection budget for no latency benefit at Glacier instant-retrieval
   * speeds.
   */
  async restoreRange(
    dataClass: RestoreResult['dataClass'],
    from: Date,
    to: Date,
    actor: string,
  ): Promise<RestoreResult[]> {
    const manifests = await this.manifest.search({ dataClass, from, to });
    const results: RestoreResult[] = [];
    for (const entry of manifests) {
      results.push(await this.restore({ manifestId: entry.id, actor }));
    }
    return results;
  }
}
