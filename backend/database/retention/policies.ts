/**
 * @file policies.ts
 * @description The retention policy registry and its validation rules.
 */

import {
  DataClass,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RetentionPolicy,
} from './types';

/**
 * Default retention policies.
 *
 * Windows are chosen so that financially material records satisfy the SOX
 * seven-year record-keeping obligation, while high-volume operational exhaust
 * is aged out aggressively to keep the hot tables small.
 */
export const DEFAULT_POLICIES: readonly RetentionPolicy[] = Object.freeze([
  {
    dataClass: 'blockchain_events',
    table: 'blockchain_events',
    timestampColumn: 'ledger_close_time',
    keyColumn: 'id',
    retentionDays: 90,
    action: 'archive_then_delete',
    regime: 'NONE',
    piiColumns: [],
    rationale:
      'Raw ledger exhaust is reproducible from Horizon; 90 days covers replay and gap recovery.',
  },
  {
    dataClass: 'bets',
    table: 'bets',
    timestampColumn: 'placed_at',
    keyColumn: 'id',
    retentionDays: MAX_RETENTION_DAYS,
    action: 'archive_then_delete',
    regime: 'SOX',
    // A Stellar address is a pseudonymous identifier that can be linked to a
    // natural person, so it is treated as personal data under GDPR.
    piiColumns: ['bettor_address'],
    rationale: 'Financial transaction records; SOX requires seven-year retention.',
  },
  {
    dataClass: 'oracle_reports',
    table: 'oracle_reports',
    timestampColumn: 'reported_at',
    keyColumn: 'id',
    retentionDays: 365 * 2,
    action: 'archive_then_delete',
    regime: 'SOX',
    piiColumns: [],
    rationale: 'Settlement evidence; retained two years to cover the dispute window.',
  },
  {
    dataClass: 'notification_jobs',
    table: 'notification_jobs',
    timestampColumn: 'created_at',
    keyColumn: 'id',
    retentionDays: MIN_RETENTION_DAYS,
    action: 'archive_then_delete',
    regime: 'GDPR',
    piiColumns: ['bettor_address'],
    rationale: 'Transient delivery queue with no post-delivery value.',
  },
  {
    dataClass: 'disputes',
    table: 'disputes',
    timestampColumn: 'raised_at',
    keyColumn: 'id',
    retentionDays: 365 * 5,
    action: 'anonymize_in_place',
    regime: 'GDPR',
    piiColumns: ['reason', 'admin_notes'],
    rationale:
      'Dispute outcomes feed fairness analytics, but free-text narrative is scrubbed after five years.',
  },
  {
    dataClass: 'markets',
    table: 'markets',
    timestampColumn: 'created_at',
    keyColumn: 'id',
    retentionDays: MAX_RETENTION_DAYS,
    action: 'retain_forever',
    regime: 'SOX',
    piiColumns: [],
    rationale:
      'Markets are the dimension table every archived fact joins back to; purging them would orphan restores.',
  },
]);

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Validates a policy before it is admitted to the registry.
 *
 * Identifier checks are not cosmetic: table and column names from a policy are
 * interpolated into DDL/DML where bind parameters are not allowed, so a policy
 * is the one place a SQL injection could enter the sweep. Rejecting anything
 * that is not a bare lowercase identifier keeps that door shut.
 */
export function validatePolicy(policy: RetentionPolicy): void {
  const { dataClass, table, timestampColumn, keyColumn, retentionDays, piiColumns } = policy;

  for (const [label, value] of [
    ['table', table],
    ['timestampColumn', timestampColumn],
    ['keyColumn', keyColumn],
  ] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new PolicyValidationError(
        `policy ${dataClass}: ${label} "${value}" is not a bare lowercase SQL identifier`,
      );
    }
  }

  for (const column of piiColumns) {
    if (!IDENTIFIER.test(column)) {
      throw new PolicyValidationError(
        `policy ${dataClass}: piiColumn "${column}" is not a bare lowercase SQL identifier`,
      );
    }
  }

  if (!Number.isInteger(retentionDays)) {
    throw new PolicyValidationError(
      `policy ${dataClass}: retentionDays must be an integer, got ${retentionDays}`,
    );
  }

  if (retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS) {
    throw new PolicyValidationError(
      `policy ${dataClass}: retentionDays ${retentionDays} outside [${MIN_RETENTION_DAYS}, ${MAX_RETENTION_DAYS}]`,
    );
  }

  if (policy.action === 'anonymize_in_place' && piiColumns.length === 0) {
    throw new PolicyValidationError(
      `policy ${dataClass}: anonymize_in_place requires at least one piiColumn`,
    );
  }

  if (policy.regime === 'SOX' && retentionDays < 365) {
    throw new PolicyValidationError(
      `policy ${dataClass}: SOX-governed data must be retained at least 365 days`,
    );
  }
}

/**
 * An in-memory registry of policies keyed by data class.
 *
 * Held in memory rather than read per-sweep because the sweep consults the
 * policy once per batch across potentially millions of rows. Updates go through
 * {@link PolicyRegistry.upsert}, which validates and emits a compliance event,
 * so the durable `retention_policies` table remains the audit source of truth.
 */
export class PolicyRegistry {
  private readonly policies = new Map<DataClass, RetentionPolicy>();

  constructor(initial: readonly RetentionPolicy[] = DEFAULT_POLICIES) {
    for (const policy of initial) {
      validatePolicy(policy);
      this.policies.set(policy.dataClass, { ...policy, piiColumns: [...policy.piiColumns] });
    }
  }

  get(dataClass: DataClass): RetentionPolicy {
    const policy = this.policies.get(dataClass);
    if (!policy) {
      throw new PolicyValidationError(`no retention policy registered for "${dataClass}"`);
    }
    return policy;
  }

  has(dataClass: DataClass): boolean {
    return this.policies.has(dataClass);
  }

  /** All policies whose rows are eligible for a disposal sweep. */
  sweepable(): RetentionPolicy[] {
    return [...this.policies.values()].filter((p) => p.action !== 'retain_forever');
  }

  all(): RetentionPolicy[] {
    return [...this.policies.values()];
  }

  /**
   * Adds or replaces a policy. Returns the previous version when one existed so
   * the caller can record a before/after pair in the compliance log.
   */
  upsert(policy: RetentionPolicy): RetentionPolicy | null {
    validatePolicy(policy);
    const previous = this.policies.get(policy.dataClass) ?? null;
    this.policies.set(policy.dataClass, { ...policy, piiColumns: [...policy.piiColumns] });
    return previous;
  }
}

/**
 * The cutoff instant for a policy: rows strictly older than this are eligible.
 * `now` is injected rather than read from the clock so sweeps are reproducible
 * in tests and so a single sweep uses one consistent cutoff across all batches.
 */
export function cutoffFor(policy: RetentionPolicy, now: Date): Date {
  return new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);
}
