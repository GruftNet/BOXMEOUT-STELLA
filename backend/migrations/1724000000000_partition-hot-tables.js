/* eslint-disable camelcase */

// Converts the two highest-volume tables to declarative range partitions.
//
//   bets              -> RANGE (placed_at)
//   blockchain_events -> RANGE (ledger_close_time)
//
// Postgres cannot ALTER an existing table into a partitioned one, so each
// table is rebuilt: rename aside, create partitioned parent, copy, drop.
//
// Partition-key constraint: every UNIQUE/PRIMARY KEY on a partitioned table
// must contain the partition key. `id` becomes (id, <ts>) and the tx_hash
// guard becomes (tx_hash, <ts>). See MIGRATION NOTE in the down() comment
// and docs in src/db/partitionManager.ts for why this stays safe.

exports.shorthands = undefined;

// Partitions are monthly. Seed a window around the existing data so the copy
// back in has somewhere to land; partitionManager keeps the window rolling.
const SEED_MONTHS_BACK = 6;
const SEED_MONTHS_FORWARD = 3;

function monthBounds(offset) {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const suffix = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { suffix, from: start.toISOString(), to: end.toISOString() };
}

function seedPartitions(pgm, parent) {
  for (let i = -SEED_MONTHS_BACK; i <= SEED_MONTHS_FORWARD; i += 1) {
    const { suffix, from, to } = monthBounds(i);
    pgm.sql(`
      CREATE TABLE IF NOT EXISTS ${parent}_${suffix}
        PARTITION OF ${parent}
        FOR VALUES FROM ('${from}') TO ('${to}')
    `);
  }
  // Catch-all for rows older than the seeded window, so the data copy cannot
  // fail on a stray historical row. Never routed to by new writes.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ${parent}_default PARTITION OF ${parent} DEFAULT
  `);
}

exports.up = (pgm) => {
  // ---------------------------------------------------------------- bets ---
  pgm.sql('ALTER TABLE bets RENAME TO bets_legacy');
  pgm.sql('ALTER TABLE bets_legacy RENAME CONSTRAINT bets_pkey TO bets_legacy_pkey');

  pgm.sql(`
    CREATE TABLE bets (
      id              BIGSERIAL   NOT NULL,
      market_id       TEXT        NOT NULL REFERENCES markets(market_id),
      bettor_address  TEXT        NOT NULL,
      side            TEXT        NOT NULL,
      amount          NUMERIC     NOT NULL,
      amount_xlm      NUMERIC     NOT NULL DEFAULT 0,
      placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed         BOOLEAN     NOT NULL DEFAULT FALSE,
      claimed_at      TIMESTAMPTZ,
      payout          NUMERIC,
      tx_hash         TEXT        NOT NULL,
      ledger_sequence INTEGER     NOT NULL DEFAULT 0,
      original_token  VARCHAR(56) DEFAULT 'XLM',
      original_amount NUMERIC(40) DEFAULT '0',
      PRIMARY KEY (id, placed_at),
      UNIQUE (tx_hash, placed_at)
    ) PARTITION BY RANGE (placed_at)
  `);

  seedPartitions(pgm, 'bets');

  pgm.sql(`
    INSERT INTO bets (
      id, market_id, bettor_address, side, amount, amount_xlm,
      placed_at, claimed, claimed_at, payout, tx_hash, ledger_sequence,
      original_token, original_amount
    )
    SELECT
      id, market_id, bettor_address, side, amount, amount_xlm,
      placed_at, claimed, claimed_at, payout, tx_hash, ledger_sequence,
      original_token, original_amount
    FROM bets_legacy
  `);

  // Keep the sequence ahead of the copied ids.
  pgm.sql(`
    SELECT setval(
      pg_get_serial_sequence('bets', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 0) FROM bets), 1)
    )
  `);

  pgm.sql('DROP TABLE bets_legacy');

  pgm.createIndex('bets', 'market_id');
  pgm.createIndex('bets', 'bettor_address');
  pgm.createIndex('bets', ['market_id', 'placed_at']);

  // --------------------------------------------------- blockchain_events ---
  pgm.sql('ALTER TABLE blockchain_events RENAME TO blockchain_events_legacy');
  pgm.sql(
    'ALTER TABLE blockchain_events_legacy RENAME CONSTRAINT blockchain_events_pkey TO blockchain_events_legacy_pkey',
  );

  pgm.sql(`
    CREATE TABLE blockchain_events (
      id                BIGSERIAL   NOT NULL,
      contract_address  TEXT        NOT NULL,
      event_type        TEXT        NOT NULL,
      payload           JSONB       NOT NULL DEFAULT '{}',
      ledger_sequence   INTEGER     NOT NULL,
      ledger_close_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tx_hash           TEXT        NOT NULL,
      processed         BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, ledger_close_time),
      UNIQUE (tx_hash, ledger_close_time)
    ) PARTITION BY RANGE (ledger_close_time)
  `);

  seedPartitions(pgm, 'blockchain_events');

  pgm.sql(`
    INSERT INTO blockchain_events (
      id, contract_address, event_type, payload, ledger_sequence,
      ledger_close_time, tx_hash, processed, created_at
    )
    SELECT
      id, contract_address, event_type, payload, ledger_sequence,
      ledger_close_time, tx_hash, processed, created_at
    FROM blockchain_events_legacy
  `);

  pgm.sql(`
    SELECT setval(
      pg_get_serial_sequence('blockchain_events', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 0) FROM blockchain_events), 1)
    )
  `);

  pgm.sql('DROP TABLE blockchain_events_legacy');

  pgm.createIndex('blockchain_events', 'ledger_sequence');
  pgm.createIndex('blockchain_events', 'contract_address');
  // Indexer scan path: unprocessed events in ledger order.
  pgm.createIndex('blockchain_events', ['processed', 'ledger_sequence'], {
    where: 'processed = FALSE',
  });

  // ------------------------------------------------- tx_hash dedup guard ---
  // Partitioning weakened the old global `tx_hash UNIQUE`: the constraint must
  // include the partition key, so it only holds *within* a partition. A write
  // retried with a re-defaulted timestamp lands in a different partition and
  // is accepted, double-crediting a bet. Verified, not theoretical.
  //
  // This registry restores the global guarantee. It stays unpartitioned so its
  // PRIMARY KEY is genuinely global, and is narrow enough to stay cheap.
  pgm.sql(`
    CREATE TABLE tx_hash_registry (
      source_table TEXT        NOT NULL,
      tx_hash      TEXT        NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (source_table, tx_hash)
    )
  `);

  // occurred_at is carried purely so retention pruning can drop registry rows
  // alongside the partitions they describe.
  pgm.createIndex('tx_hash_registry', 'occurred_at');

  pgm.sql(`
    CREATE OR REPLACE FUNCTION tx_hash_registry_guard() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO tx_hash_registry (source_table, tx_hash, occurred_at)
      VALUES ('bets', NEW.tx_hash, NEW.placed_at);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Separate function per table: the timestamp column differs, and a trigger
  // function cannot parameterise a column reference.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION tx_hash_registry_guard_events() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO tx_hash_registry (source_table, tx_hash, occurred_at)
      VALUES ('blockchain_events', NEW.tx_hash, NEW.ledger_close_time);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  pgm.sql(`
    CREATE TRIGGER bets_tx_hash_guard
      BEFORE INSERT ON bets
      FOR EACH ROW EXECUTE FUNCTION tx_hash_registry_guard()
  `);

  pgm.sql(`
    CREATE TRIGGER blockchain_events_tx_hash_guard
      BEFORE INSERT ON blockchain_events
      FOR EACH ROW EXECUTE FUNCTION tx_hash_registry_guard_events()
  `);

  // Backfill from the rows copied in above, so the guard covers existing data.
  pgm.sql(`
    INSERT INTO tx_hash_registry (source_table, tx_hash, occurred_at)
    SELECT 'bets', tx_hash, placed_at FROM bets
    ON CONFLICT DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO tx_hash_registry (source_table, tx_hash, occurred_at)
    SELECT 'blockchain_events', tx_hash, ledger_close_time FROM blockchain_events
    ON CONFLICT DO NOTHING
  `);

  // Registry backing src/db/shardMap.ts. Single row per logical shard; the
  // default deployment is one shard, so routing is a no-op until a second
  // row exists.
  pgm.createTable('shard_map', {
    id: { type: 'serial', primaryKey: true },
    shard_key: { type: 'text', notNull: true, unique: true },
    dsn_env_var: { type: 'text', notNull: true },
    slot_start: { type: 'integer', notNull: true },
    slot_end: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' },
    last_health_check_at: { type: 'timestamptz' },
    healthy: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('shard_map', 'shard_map_slot_range_valid', {
    check: 'slot_start >= 0 AND slot_end > slot_start AND slot_end <= 4096',
  });

  pgm.sql(`
    INSERT INTO shard_map (shard_key, dsn_env_var, slot_start, slot_end)
    VALUES ('shard-0', 'DATABASE_URL', 0, 4096)
  `);
};

// MIGRATION NOTE: down() restores unpartitioned tables. It will fail if the
// data no longer fits the original INTEGER id or if duplicate tx_hash rows
// were somehow written across partitions — both are intentional loud failures
// rather than silent data loss.
exports.down = (pgm) => {
  pgm.dropTable('shard_map');

  // Drop the guard before rebuilding the tables — the triggers reference them.
  pgm.sql('DROP TRIGGER IF EXISTS bets_tx_hash_guard ON bets');
  pgm.sql('DROP TRIGGER IF EXISTS blockchain_events_tx_hash_guard ON blockchain_events');
  pgm.sql('DROP FUNCTION IF EXISTS tx_hash_registry_guard()');
  pgm.sql('DROP FUNCTION IF EXISTS tx_hash_registry_guard_events()');
  pgm.dropTable('tx_hash_registry');

  for (const [parent, tsColumn] of [
    ['bets', 'placed_at'],
    ['blockchain_events', 'ledger_close_time'],
  ]) {
    pgm.sql(`CREATE TABLE ${parent}_flat (LIKE ${parent} INCLUDING DEFAULTS)`);
    pgm.sql(`INSERT INTO ${parent}_flat SELECT * FROM ${parent}`);
    pgm.sql(`DROP TABLE ${parent} CASCADE`);
    pgm.sql(`ALTER TABLE ${parent}_flat RENAME TO ${parent}`);
    pgm.sql(`ALTER TABLE ${parent} ADD PRIMARY KEY (id)`);
    pgm.sql(`ALTER TABLE ${parent} ADD CONSTRAINT ${parent}_tx_hash_key UNIQUE (tx_hash)`);
    pgm.sql(`ALTER TABLE ${parent} ALTER COLUMN ${tsColumn} SET DEFAULT NOW()`);
  }

  pgm.sql('ALTER TABLE bets ADD CONSTRAINT bets_market_id_fkey FOREIGN KEY (market_id) REFERENCES markets(market_id)');
};
