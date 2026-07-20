CREATE TABLE IF NOT EXISTS markets (
  id               SERIAL PRIMARY KEY,
  market_id        TEXT        NOT NULL UNIQUE,
  contract_address TEXT        NOT NULL,
  match_id         TEXT        NOT NULL,
  fighter_a        TEXT        NOT NULL,
  fighter_b        TEXT        NOT NULL,
  weight_class     TEXT        NOT NULL DEFAULT '',
  title_fight      BOOLEAN     NOT NULL DEFAULT FALSE,
  venue            TEXT        NOT NULL DEFAULT '',
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT        NOT NULL DEFAULT 'open',
  outcome          TEXT,
  pool_a           NUMERIC     NOT NULL DEFAULT 0,
  pool_b           NUMERIC     NOT NULL DEFAULT 0,
  pool_draw        NUMERIC     NOT NULL DEFAULT 0,
  total_pool       NUMERIC     NOT NULL DEFAULT 0,
  fee_bps          INTEGER     NOT NULL DEFAULT 200,
  lock_before_secs INTEGER     NOT NULL DEFAULT 3600,
  resolved_at      TIMESTAMPTZ,
  oracle_used      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ledger_sequence  INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id               SERIAL PRIMARY KEY,
  market_id        TEXT        NOT NULL REFERENCES markets(market_id),
  bettor_address   TEXT        NOT NULL,
  side             TEXT        NOT NULL,
  amount           NUMERIC     NOT NULL,
  amount_xlm       NUMERIC     NOT NULL DEFAULT 0,
  placed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed          BOOLEAN     NOT NULL DEFAULT FALSE,
  claimed_at       TIMESTAMPTZ,
  payout           NUMERIC,
  tx_hash          TEXT        NOT NULL UNIQUE,
  ledger_sequence  INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blockchain_events (
  id                SERIAL PRIMARY KEY,
  contract_address  TEXT        NOT NULL,
  event_type        TEXT        NOT NULL,
  payload           JSONB       NOT NULL DEFAULT '{}',
  ledger_sequence   INTEGER     NOT NULL,
  ledger_close_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tx_hash           TEXT        NOT NULL UNIQUE,
  processed         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  id                      SERIAL PRIMARY KEY,
  last_processed_ledger   INTEGER     NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_reports (
  id               SERIAL PRIMARY KEY,
  match_id         TEXT        NOT NULL,
  oracle_address   TEXT        NOT NULL,
  outcome          TEXT        NOT NULL,
  reported_at      TIMESTAMPTZ NOT NULL,
  signature        TEXT        NOT NULL,
  accepted         BOOLEAN     NOT NULL DEFAULT FALSE,
  tx_hash          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
  id               SERIAL PRIMARY KEY,
  market_id        TEXT        NOT NULL REFERENCES markets(market_id),
  reason           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open',
  admin_notes      TEXT,
  final_outcome    TEXT,
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at      TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id               SERIAL PRIMARY KEY,
  bettor_address   TEXT        NOT NULL,
  market_id        TEXT        NOT NULL REFERENCES markets(market_id),
  job_type         TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Data retention subsystem (see backend/database/retention/).
-- Kept in sync with migration 1724000000000_add-retention-tables.js; the
-- integration suite bootstraps from this file, so a change here without the
-- matching migration would let tests pass against a shape production never has.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retention_policies (
  id               SERIAL PRIMARY KEY,
  data_class       TEXT        NOT NULL UNIQUE,
  table_name       TEXT        NOT NULL,
  timestamp_column TEXT        NOT NULL,
  key_column       TEXT        NOT NULL DEFAULT 'id',
  retention_days   INTEGER     NOT NULL CHECK (retention_days >= 30 AND retention_days <= 2555),
  action           TEXT        NOT NULL CHECK (action IN ('archive_then_delete', 'anonymize_in_place', 'retain_forever')),
  regime           TEXT        NOT NULL DEFAULT 'NONE',
  pii_columns      TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  rationale        TEXT        NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       TEXT        NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS retention_archive_manifest (
  id                   SERIAL PRIMARY KEY,
  data_class           TEXT        NOT NULL,
  object_key           TEXT        NOT NULL UNIQUE,
  checksum             TEXT        NOT NULL,
  size_bytes           BIGINT      NOT NULL,
  row_count            INTEGER     NOT NULL,
  range_start          TIMESTAMPTZ NOT NULL,
  range_end            TIMESTAMPTZ NOT NULL,
  min_key              TEXT        NOT NULL,
  max_key              TEXT        NOT NULL,
  storage_class        TEXT        NOT NULL DEFAULT 'GLACIER_IR',
  archived_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deletion_verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS retention_manifest_class_range_idx
  ON retention_archive_manifest (data_class, range_start, range_end);
CREATE INDEX IF NOT EXISTS retention_manifest_unverified_idx
  ON retention_archive_manifest (archived_at) WHERE deletion_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS retention_compliance_log (
  id          SERIAL PRIMARY KEY,
  action      TEXT        NOT NULL,
  data_class  TEXT,
  regime      TEXT        NOT NULL DEFAULT 'NONE',
  row_count   INTEGER,
  detail      JSONB       NOT NULL DEFAULT '{}'::JSONB,
  actor       TEXT        NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prev_hash   TEXT,
  entry_hash  TEXT        NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS retention_compliance_class_time_idx
  ON retention_compliance_log (data_class, recorded_at);
CREATE INDEX IF NOT EXISTS retention_compliance_time_idx
  ON retention_compliance_log (recorded_at);

CREATE OR REPLACE FUNCTION retention_compliance_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'retention_compliance_log is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS retention_compliance_log_no_mutate ON retention_compliance_log;
CREATE TRIGGER retention_compliance_log_no_mutate
  BEFORE UPDATE OR DELETE ON retention_compliance_log
  FOR EACH ROW EXECUTE FUNCTION retention_compliance_log_append_only();
