/**
 * @file policy-store.ts
 * @description Durable persistence for retention policies and their revisions.
 */

import { ComplianceLog, Queryable } from './compliance-log';
import { DEFAULT_POLICIES, PolicyRegistry, validatePolicy } from './policies';
import { ComplianceRegime, DataClass, DisposalAction, RetentionPolicy } from './types';

interface PolicyRow {
  data_class: string;
  table_name: string;
  timestamp_column: string;
  key_column: string;
  retention_days: number;
  action: string;
  regime: string;
  pii_columns: string[];
  rationale: string;
}

function toPolicy(row: PolicyRow): RetentionPolicy {
  return {
    dataClass: row.data_class as DataClass,
    table: row.table_name,
    timestampColumn: row.timestamp_column,
    keyColumn: row.key_column,
    retentionDays: row.retention_days,
    action: row.action as DisposalAction,
    regime: row.regime as ComplianceRegime,
    piiColumns: row.pii_columns ?? [],
    rationale: row.rationale,
  };
}

export class PolicyStore {
  constructor(
    private readonly db: Queryable,
    private readonly complianceLog: ComplianceLog,
  ) {}

  /**
   * Writes the built-in defaults for any class that has no stored policy yet.
   *
   * `DO NOTHING` rather than an upsert: once an operator has tuned a window,
   * a deploy must not silently revert it to the shipped default.
   */
  async seedDefaults(actor = 'system'): Promise<number> {
    let seeded = 0;
    for (const policy of DEFAULT_POLICIES) {
      const { rowCount } = await this.db.query(
        `INSERT INTO retention_policies
           (data_class, table_name, timestamp_column, key_column, retention_days,
            action, regime, pii_columns, rationale, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (data_class) DO NOTHING`,
        [
          policy.dataClass,
          policy.table,
          policy.timestampColumn,
          policy.keyColumn,
          policy.retentionDays,
          policy.action,
          policy.regime,
          policy.piiColumns,
          policy.rationale,
          actor,
        ],
      );
      if ((rowCount ?? 0) > 0) {
        seeded += 1;
        await this.complianceLog.record({
          action: 'policy_created',
          dataClass: policy.dataClass,
          regime: policy.regime,
          rowCount: null,
          detail: { retentionDays: policy.retentionDays, disposal: policy.action },
          actor,
        });
      }
    }
    return seeded;
  }

  async loadAll(): Promise<RetentionPolicy[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT data_class, table_name, timestamp_column, key_column, retention_days,
              action, regime, pii_columns, rationale
         FROM retention_policies
        ORDER BY data_class`,
    );
    return rows.map(toPolicy);
  }

  /**
   * Builds a registry from the stored policies, falling back to the shipped
   * defaults when the table is empty (a fresh database, or a deployment that
   * has not run `seedDefaults` yet). Never returns an empty registry, because a
   * sweep with no policies would silently do nothing and look healthy.
   */
  async loadRegistry(): Promise<PolicyRegistry> {
    const stored = await this.loadAll();
    return new PolicyRegistry(stored.length > 0 ? stored : DEFAULT_POLICIES);
  }

  /**
   * Updates a policy, recording the before/after pair in the compliance log.
   *
   * Shortening a window is the operation that destroys data on the next sweep,
   * so the diff is what an auditor needs to answer "who authorised deleting
   * this, and when".
   */
  async update(policy: RetentionPolicy, actor: string): Promise<RetentionPolicy | null> {
    validatePolicy(policy);

    const { rows: existingRows } = await this.db.query<PolicyRow>(
      `SELECT data_class, table_name, timestamp_column, key_column, retention_days,
              action, regime, pii_columns, rationale
         FROM retention_policies
        WHERE data_class = $1`,
      [policy.dataClass],
    );
    const previous = existingRows[0] ? toPolicy(existingRows[0]) : null;

    await this.db.query(
      `INSERT INTO retention_policies
         (data_class, table_name, timestamp_column, key_column, retention_days,
          action, regime, pii_columns, rationale, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
       ON CONFLICT (data_class) DO UPDATE
         SET table_name       = EXCLUDED.table_name,
             timestamp_column = EXCLUDED.timestamp_column,
             key_column       = EXCLUDED.key_column,
             retention_days   = EXCLUDED.retention_days,
             action           = EXCLUDED.action,
             regime           = EXCLUDED.regime,
             pii_columns      = EXCLUDED.pii_columns,
             rationale        = EXCLUDED.rationale,
             updated_at       = NOW(),
             updated_by       = EXCLUDED.updated_by`,
      [
        policy.dataClass,
        policy.table,
        policy.timestampColumn,
        policy.keyColumn,
        policy.retentionDays,
        policy.action,
        policy.regime,
        policy.piiColumns,
        policy.rationale,
        actor,
      ],
    );

    await this.complianceLog.record({
      action: previous ? 'policy_updated' : 'policy_created',
      dataClass: policy.dataClass,
      regime: policy.regime,
      rowCount: null,
      detail: {
        previous: previous
          ? { retentionDays: previous.retentionDays, disposal: previous.action }
          : null,
        next: { retentionDays: policy.retentionDays, disposal: policy.action },
        shortensWindow: previous ? policy.retentionDays < previous.retentionDays : false,
      },
      actor,
    });

    return previous;
  }
}
