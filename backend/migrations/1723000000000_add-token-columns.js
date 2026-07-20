/* eslint-disable camelcase */

// NOTE: this migration previously destructured its argument as a `pg.Pool` and
// called `pool.query(...)`. node-pg-migrate passes a MigrationBuilder, so it
// threw `pool.query is not a function` and never applied. Rewritten to use
// `pgm.sql`; the SQL itself is unchanged and remains idempotent.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE bets
    ADD COLUMN IF NOT EXISTS original_token VARCHAR(56) DEFAULT 'XLM',
    ADD COLUMN IF NOT EXISTS original_amount NUMERIC(40) DEFAULT '0'
  `);

  pgm.sql('CREATE INDEX IF NOT EXISTS bets_original_token_idx ON bets(original_token)');
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS bets_original_token_idx');
  pgm.sql(`
    ALTER TABLE bets
    DROP COLUMN IF EXISTS original_token,
    DROP COLUMN IF EXISTS original_amount
  `);
};
