/* eslint-disable camelcase */

/**
 * Tables backing the data retention subsystem: the durable policy record, the
 * searchable archive manifest, and the tamper-evident compliance audit trail.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('retention_policies', {
    id: 'id',
    data_class: { type: 'text', notNull: true, unique: true },
    table_name: { type: 'text', notNull: true },
    timestamp_column: { type: 'text', notNull: true },
    key_column: { type: 'text', notNull: true, default: 'id' },
    retention_days: { type: 'integer', notNull: true },
    action: { type: 'text', notNull: true },
    regime: { type: 'text', notNull: true, default: 'NONE' },
    pii_columns: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    rationale: { type: 'text', notNull: true, default: '' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_by: { type: 'text', notNull: true, default: 'system' },
  });

  // Mirrors MIN/MAX_RETENTION_DAYS in types.ts. Enforced here as well so a
  // direct SQL edit cannot install a policy the application would reject.
  pgm.addConstraint('retention_policies', 'retention_policies_days_range', {
    check: 'retention_days >= 30 AND retention_days <= 2555',
  });
  pgm.addConstraint('retention_policies', 'retention_policies_action_valid', {
    check: "action IN ('archive_then_delete', 'anonymize_in_place', 'retain_forever')",
  });

  pgm.createTable('retention_archive_manifest', {
    id: 'id',
    data_class: { type: 'text', notNull: true },
    object_key: { type: 'text', notNull: true, unique: true },
    checksum: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    row_count: { type: 'integer', notNull: true },
    range_start: { type: 'timestamptz', notNull: true },
    range_end: { type: 'timestamptz', notNull: true },
    min_key: { type: 'text', notNull: true },
    max_key: { type: 'text', notNull: true },
    storage_class: { type: 'text', notNull: true, default: 'GLACIER_IR' },
    archived_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    deletion_verified_at: { type: 'timestamptz' },
  });

  // Serves the primary search path: narrow by class, then by overlapping range.
  pgm.createIndex('retention_archive_manifest', ['data_class', 'range_start', 'range_end'], {
    name: 'retention_manifest_class_range_idx',
  });
  // Partial index so the "archived but not provably deleted" alert query stays
  // cheap as the manifest grows; the healthy case is an empty set.
  pgm.createIndex('retention_archive_manifest', 'archived_at', {
    name: 'retention_manifest_unverified_idx',
    where: 'deletion_verified_at IS NULL',
  });

  pgm.createTable('retention_compliance_log', {
    id: 'id',
    action: { type: 'text', notNull: true },
    data_class: { type: 'text' },
    regime: { type: 'text', notNull: true, default: 'NONE' },
    row_count: { type: 'integer' },
    detail: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    actor: { type: 'text', notNull: true },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    prev_hash: { type: 'text' },
    entry_hash: { type: 'text', notNull: true, unique: true },
  });

  pgm.createIndex('retention_compliance_log', ['data_class', 'recorded_at'], {
    name: 'retention_compliance_class_time_idx',
  });
  pgm.createIndex('retention_compliance_log', 'recorded_at', {
    name: 'retention_compliance_time_idx',
  });

  // The hash chain makes tampering detectable; this trigger makes it hard.
  // Without it, an operator with table privileges could rewrite history and
  // re-chain the hashes, which would defeat the audit guarantee entirely.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION retention_compliance_log_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'retention_compliance_log is append-only; % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER retention_compliance_log_no_mutate
      BEFORE UPDATE OR DELETE ON retention_compliance_log
      FOR EACH ROW EXECUTE FUNCTION retention_compliance_log_append_only();
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS retention_compliance_log_no_mutate ON retention_compliance_log;');
  pgm.sql('DROP FUNCTION IF EXISTS retention_compliance_log_append_only();');
  pgm.dropTable('retention_compliance_log');
  pgm.dropTable('retention_archive_manifest');
  pgm.dropTable('retention_policies');
};
