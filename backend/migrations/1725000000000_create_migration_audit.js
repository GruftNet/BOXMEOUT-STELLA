/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('migration_audit', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
    current_step: { type: 'text' },
    progress: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('migration_audit', 'status');
  pgm.createIndex('migration_audit', 'started_at');
};

exports.down = (pgm) => {
  pgm.dropIndex('migration_audit', 'status');
  pgm.dropTable('migration_audit');
};
