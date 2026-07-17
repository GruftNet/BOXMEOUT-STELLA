/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Replication monitoring table
  pgm.createTable('replication_state', {
    id: { type: 'serial', primaryKey: true },
    replica_id: { type: 'text', notNull: true, unique: true },
    is_healthy: { type: 'boolean', notNull: true, default: true },
    lag_bytes: { type: 'bigint', notNull: true, default: 0 },
    lag_seconds: { type: 'integer', notNull: true, default: 0 },
    last_heartbeat: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    flush_lsn: { type: 'text', notNull: true, default: '0/0' },
    replay_lsn: { type: 'text', notNull: true, default: '0/0' },
    slot_name: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('replication_state', 'is_healthy');
  pgm.createIndex('replication_state', 'last_heartbeat');

  // Replication metrics history
  pgm.createTable('replication_metrics', {
    id: { type: 'serial', primaryKey: true },
    replica_id: { type: 'text', notNull: true },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    lag_bytes: { type: 'bigint', notNull: true },
    lag_seconds: { type: 'integer', notNull: true },
    network_latency_ms: { type: 'integer', notNull: true, default: 0 },
    bytes_received: { type: 'bigint', notNull: true, default: 0 },
    bytes_replayed: { type: 'bigint', notNull: true, default: 0 },
    transactions_applied: { type: 'integer', notNull: true, default: 0 },
  });

  // Index for time-series queries
  pgm.createIndex('replication_metrics', ['replica_id', 'recorded_at']);

  // Failover events log
  pgm.createTable('failover_events', {
    id: { type: 'serial', primaryKey: true },
    failed_primary_id: { type: 'text', notNull: true },
    selected_replica_id: { type: 'text', notNull: true },
    failover_time: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    rto_ms: { type: 'integer', notNull: true },
    data_loss_bytes: { type: 'bigint' },
    status: { type: 'text', notNull: true, default: 'completed' },
  });

  pgm.createIndex('failover_events', 'failover_time');
  pgm.createIndex('failover_events', 'status');

  // Replication verification log
  pgm.createTable('replication_verification', {
    id: { type: 'serial', primaryKey: true },
    replica_id: { type: 'text', notNull: true },
    verified_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    verified: { type: 'boolean', notNull: true },
    primary_lsn: { type: 'text', notNull: true },
    replica_lsn: { type: 'text', notNull: true },
    lag_seconds: { type: 'integer', notNull: true },
    data_consistent: { type: 'boolean', notNull: true },
    failure_reason: { type: 'text' },
  });

  pgm.createIndex('replication_verification', ['replica_id', 'verified_at']);
  pgm.createIndex('replication_verification', 'verified');

  // Conflict resolution log
  pgm.createTable('conflict_resolutions', {
    id: { type: 'serial', primaryKey: true },
    table_name: { type: 'text', notNull: true },
    column_name: { type: 'text', notNull: true },
    row_id: { type: 'text', notNull: true },
    primary_value: { type: 'jsonb' },
    replica_value: { type: 'jsonb' },
    resolved_value: { type: 'jsonb', notNull: true },
    resolution_strategy: { type: 'text', notNull: true },
    resolved_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('conflict_resolutions', 'resolved_at');
  pgm.createIndex('conflict_resolutions', 'resolution_strategy');
};

exports.down = (pgm) => {
  pgm.dropTable('conflict_resolutions');
  pgm.dropTable('replication_verification');
  pgm.dropTable('failover_events');
  pgm.dropTable('replication_metrics');
  pgm.dropTable('replication_state');
};
