/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('circuit_breaker_events', {
    id: { type: 'serial', primaryKey: true },
    market_id: { type: 'text', notNull: true },
    trigger_type: { type: 'text', notNull: true },
    imbalance_ratio: { type: 'numeric(10,6)', notNull: true },
    total_pool_xlm: { type: 'numeric(20,7)', notNull: true },
    triggered_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    resolved_at: { type: 'timestamptz' },
  });

  pgm.createIndex('circuit_breaker_events', 'market_id');
  pgm.createIndex('circuit_breaker_events', 'trigger_type');

  // Partial unique index: only one unresolved breaker per (market_id, trigger_type)
  pgm.createIndex('circuit_breaker_events', ['market_id', 'trigger_type'], {
    name: 'circuit_breaker_events_active_uniq',
    unique: true,
    where: 'resolved_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('circuit_breaker_events');
};
