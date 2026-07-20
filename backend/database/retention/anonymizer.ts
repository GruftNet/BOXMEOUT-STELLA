/**
 * @file anonymizer.ts
 * @description Irreversible scrubbing of personal data prior to archival or deletion.
 */

import { createHmac } from 'crypto';
import { RetentionPolicy } from './types';

/**
 * Marker written into scrubbed free-text columns. Chosen to be recognisable in
 * an export and to never collide with real content.
 */
export const REDACTED = '[redacted]';

/**
 * Pseudonymises an identifier with a keyed hash.
 *
 * A keyed HMAC rather than a plain digest is deliberate: Stellar addresses come
 * from a small enough space that an unkeyed SHA-256 is trivially reversible by
 * brute force, which would leave the "anonymised" data still personal under
 * GDPR. The key must be secret and must outlive the data, because rotating it
 * breaks the ability to correlate two rows anonymised at different times.
 */
export function pseudonymize(value: string, key: string): string {
  return `anon_${createHmac('sha256', key).update(value).digest('hex').slice(0, 32)}`;
}

export class AnonymizerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnonymizerConfigError';
  }
}

/**
 * Columns whose values are identifiers worth pseudonymising rather than
 * blanking, so that archived rows remain joinable to each other.
 */
const IDENTIFIER_COLUMNS = new Set(['bettor_address', 'oracle_address', 'contract_address']);

export class Anonymizer {
  private readonly key: string;

  constructor(key: string | undefined = process.env.RETENTION_ANONYMIZATION_KEY) {
    if (!key || key.length < 32) {
      throw new AnonymizerConfigError(
        'RETENTION_ANONYMIZATION_KEY must be set to at least 32 characters; ' +
          'a weak key makes pseudonymised addresses reversible by brute force',
      );
    }
    this.key = key;
  }

  /**
   * Returns a copy of `row` with the policy's PII columns scrubbed. The input
   * is never mutated, so a caller can still use the original row to build the
   * delete predicate after anonymising the copy it archives.
   */
  scrubRow(row: Record<string, unknown>, policy: RetentionPolicy): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = { ...row };

    for (const column of policy.piiColumns) {
      const value = scrubbed[column];
      if (value === null || value === undefined) {
        continue;
      }
      scrubbed[column] = IDENTIFIER_COLUMNS.has(column)
        ? pseudonymize(String(value), this.key)
        : REDACTED;
    }

    return scrubbed;
  }

  scrubRows(
    rows: Record<string, unknown>[],
    policy: RetentionPolicy,
  ): Record<string, unknown>[] {
    return rows.map((row) => this.scrubRow(row, policy));
  }

  /**
   * Builds the `SET` fragment for an in-place anonymisation UPDATE.
   *
   * Identifier columns are pseudonymised in the application rather than in SQL
   * because the HMAC key must not be sent to the database, where it would land
   * in `pg_stat_statements` and the query log. Those columns are therefore
   * returned as bind parameters computed per row by {@link scrubRow}.
   */
  buildScrubAssignments(policy: RetentionPolicy): { columns: string[]; usesPerRowValues: boolean } {
    const columns = policy.piiColumns;
    const usesPerRowValues = columns.some((c) => IDENTIFIER_COLUMNS.has(c));
    return { columns, usesPerRowValues };
  }
}
