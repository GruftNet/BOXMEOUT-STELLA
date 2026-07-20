/**
 * @file archive-store.ts
 * @description Cold storage backends for archived row batches.
 */

import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ArchiveBatch, ArchiveObject } from './types';

/**
 * Serialisation format for an archived batch.
 *
 * Newline-delimited JSON rather than a single JSON array so a restore can
 * stream and filter without materialising the whole batch, and gzipped because
 * this data is overwhelmingly repeated keys and timestamps — compression is
 * where most of the storage-cost reduction actually comes from.
 */
export function serializeBatch(batch: ArchiveBatch): Buffer {
  const ndjson = batch.rows.map((row) => JSON.stringify(row)).join('\n');
  return gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 });
}

export function deserializeBatch(payload: Buffer): Record<string, unknown>[] {
  const ndjson = gunzipSync(payload).toString('utf8');
  if (ndjson.length === 0) {
    return [];
  }
  return ndjson.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function checksumOf(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Builds a deterministic object key.
 *
 * The date prefix keeps objects that age out together adjacent, which matters
 * because lifecycle transitions and bulk restores are both cheapest when they
 * touch a contiguous key range.
 */
export function buildObjectKey(batch: ArchiveBatch): string {
  const day = batch.rangeStart.toISOString().slice(0, 10);
  return `retention/${batch.dataClass}/${day}/${batch.minKey}-${batch.maxKey}.ndjson.gz`;
}

export interface ColdStorageBackend {
  /** Human-readable storage class recorded in the manifest. */
  readonly storageClass: string;
  put(key: string, payload: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class ColdStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ColdStorageError';
  }
}

/**
 * Filesystem-backed cold storage.
 *
 * Used by tests and local development, and viable in production for an
 * NFS/EFS-mounted archive tier. Keeps the archival pipeline runnable without an
 * AWS credential, which is what makes the integration tests hermetic.
 */
export class FilesystemColdStorage implements ColdStorageBackend {
  readonly storageClass = 'FILESYSTEM';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    // Object keys are built from data-derived values; refuse anything that
    // escapes the archive root rather than trusting them.
    if (full !== path.resolve(this.root) && !full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new ColdStorageError(`object key "${key}" escapes the archive root`);
    }
    return full;
  }

  async put(key: string, payload: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write to a temp file and rename so a crash mid-write cannot leave a
    // truncated object that would later fail checksum verification after the
    // source rows were already deleted.
    const tmp = `${full}.tmp`;
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, full);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      throw new ColdStorageError(`failed to read archive object "${key}"`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export interface S3GlacierConfig {
  bucket: string;
  /** Any S3 storage class; defaults to the Glacier instant-retrieval tier. */
  storageClass?: string;
  region?: string;
}

/**
 * S3 Glacier backed cold storage.
 *
 * Defaults to `GLACIER_IR` rather than `DEEP_ARCHIVE` because the restore SLO
 * is under one hour: deep archive's standard retrieval is measured in hours and
 * would miss it outright, whereas instant retrieval reads back in milliseconds
 * at roughly a quarter of standard storage cost.
 *
 * The AWS SDK is resolved lazily so that neither the tests nor a deployment
 * that only uses filesystem archival need `@aws-sdk/client-s3` installed.
 */
export class S3GlacierColdStorage implements ColdStorageBackend {
  readonly storageClass: string;
  private client: unknown;

  constructor(private readonly config: S3GlacierConfig) {
    this.storageClass = config.storageClass ?? 'GLACIER_IR';
  }

  private async getClient(): Promise<{
    send: (command: unknown) => Promise<Record<string, unknown>>;
  }> {
    if (!this.client) {
      let sdk: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sdk = require('@aws-sdk/client-s3') as Record<string, unknown>;
      } catch (err) {
        throw new ColdStorageError(
          'S3GlacierColdStorage requires the optional dependency @aws-sdk/client-s3; ' +
            'install it or configure FilesystemColdStorage instead',
          err,
        );
      }
      const S3Client = sdk.S3Client as new (opts: Record<string, unknown>) => unknown;
      this.client = new S3Client(this.config.region ? { region: this.config.region } : {});
    }
    return this.client as { send: (command: unknown) => Promise<Record<string, unknown>> };
  }

  private commands(): Record<string, new (input: Record<string, unknown>) => unknown> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@aws-sdk/client-s3') as Record<
      string,
      new (input: Record<string, unknown>) => unknown
    >;
  }

  async put(key: string, payload: Buffer): Promise<void> {
    const client = await this.getClient();
    const { PutObjectCommand } = this.commands();
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: payload,
        StorageClass: this.storageClass,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const client = await this.getClient();
    const { GetObjectCommand } = this.commands();
    const response = await client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const body = response.Body as { transformToByteArray: () => Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.getClient();
    const { HeadObjectCommand } = this.commands();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = this.commands();
    await client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
