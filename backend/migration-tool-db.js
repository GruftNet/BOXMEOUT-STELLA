/**
 * Lightweight DB helpers used by the migration runner.
 * CommonJS so it can be executed with plain `node`.
 */
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION || '';

if (!DATABASE_URL) {
  // Defer throwing to runtime use; some commands may only inspect files.
}

function createPool() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString: DATABASE_URL });
}

async function withClient(fn) {
  const pool = createPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function ensureMigrationAuditTable() {
  return withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_audit (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        current_step TEXT,
        progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  });
}

async function insertAuditRun(name) {
  return withClient(async (client) => {
    const res = await client.query(
      `INSERT INTO migration_audit (name, status, started_at) VALUES ($1, 'running', now()) RETURNING *`,
      [name]
    );
    return res.rows[0];
  });
}

async function updateAuditProgress(id, fields = {}) {
  return withClient(async (client) => {
    const updates = [];
    const values = [];
    let idx = 1;
    Object.entries(fields).forEach(([k, v]) => {
      updates.push(`${k} = $${idx}`);
      values.push(v);
      idx++;
    });
    if (updates.length === 0) return null;
    values.push(id);
    const q = `UPDATE migration_audit SET ${updates.join(', ')}, updated_at = now() WHERE id = $${idx} RETURNING *`;
    const res = await client.query(q, values);
    return res.rows[0];
  });
}

async function getAppliedMigrations() {
  return withClient(async (client) => {
    // node-pg-migrate stores migrations in 'pgmigrations' by default
    const exists = await client.query(`
      SELECT to_regclass('public.pgmigrations') IS NOT NULL AS exists
    `);
    if (!exists.rows[0].exists) return [];
    const res = await client.query(`SELECT name, run_on FROM pgmigrations ORDER BY run_on ASC`);
    return res.rows.map((r) => r.name);
  });
}

module.exports = {
  createPool,
  withClient,
  ensureMigrationAuditTable,
  insertAuditRun,
  updateAuditProgress,
  getAppliedMigrations,
};
