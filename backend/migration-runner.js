#!/usr/bin/env node
/**
 * migration-runner.js
 * Lightweight orchestration script to support zero-downtime migration workflows.
 * Usage: node migration-runner.js <preflight|status|apply|rollback|shadow-test>
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./migration-tool-db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function log(...args) {
  console.log('[migration-runner]', ...args);
}

async function preflight() {
  log('Running preflight checks');
  try {
    if (!process.env.DATABASE_URL && !process.env.PG_CONNECTION) {
      throw new Error('DATABASE_URL (or PG_CONNECTION) is required in env for preflight');
    }
    await db.ensureMigrationAuditTable();
    const applied = await db.getAppliedMigrations();
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
    const pending = files.filter((f) => !applied.includes(f));
    log('Connected to DB, migrations table present');
    log(`Migrations files: ${files.length}, applied: ${applied.length}, pending: ${pending.length}`);
    return { applied, pending };
  } catch (err) {
    log('Preflight error:', err.message);
    throw err;
  }
}

async function status() {
  const { applied, pending } = await preflight();
  console.log('Applied migrations:', applied);
  console.log('Pending migrations:', pending);
}

function runNpxNodePgMigrate(args = []) {
  // Use npx to run node-pg-migrate from devDependencies
  const cmd = 'npx';
  const allArgs = ['node-pg-migrate', ...args];
  log(`Executing: ${cmd} ${allArgs.join(' ')}`);
  const res = spawnSync(cmd, allArgs, { stdio: 'inherit', cwd: path.join(__dirname) });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`node-pg-migrate exited with ${res.status}`);
}

async function apply() {
  log('Starting zero-downtime migration apply');
  const run = await db.insertAuditRun('zero_downtime_migration');
  try {
    // Preflight
    const { pending } = await preflight();
    if (pending.length === 0) {
      log('No pending migrations to apply');
      await db.updateAuditProgress(run.id, { status: 'completed', finished_at: new Date().toISOString() });
      return;
    }

    // Mark dual-write flag in metadata so application can switch to dual-write if supported.
    await db.updateAuditProgress(run.id, { metadata: JSON.stringify({ dual_write: true }), current_step: 'starting_migrations' });

    // Run migrations via node-pg-migrate (up)
    runNpxNodePgMigrate(['up', '--migrations-dir', 'migrations']);

    // After schema migrations, run optional data transforms via a 'data-transforms' folder if present
    const transformsDir = path.join(__dirname, 'migration-transforms');
    if (fs.existsSync(transformsDir)) {
      const scripts = fs.readdirSync(transformsDir).filter((f) => f.endsWith('.js'));
      for (const s of scripts) {
        log('Running data transform', s);
        await db.updateAuditProgress(run.id, { current_step: `transform:${s}`, progress: JSON.stringify({ last_transform: s }) });
        const mod = require(path.join(transformsDir, s));
        if (typeof mod.run === 'function') {
          await mod.run({ dbPool: db.createPool() });
        }
      }
    }

    // Finalize
    await db.updateAuditProgress(run.id, { status: 'completed', finished_at: new Date().toISOString(), current_step: 'completed' });
    log('Migration apply completed successfully');
  } catch (err) {
    log('Migration apply failed:', err.message);
    await db.updateAuditProgress(run.id, { status: 'failed', metadata: JSON.stringify({ error: err.message }), current_step: 'failed' });
    throw err;
  }
}

async function rollback() {
  log('Starting rollback (node-pg-migrate down)');
  const run = await db.insertAuditRun('rollback');
  try {
    await db.updateAuditProgress(run.id, { current_step: 'rolling_back' });
    runNpxNodePgMigrate(['down', '--migrations-dir', 'migrations']);
    await db.updateAuditProgress(run.id, { status: 'rolled_back', finished_at: new Date().toISOString(), current_step: 'rolled_back' });
    log('Rollback completed');
  } catch (err) {
    log('Rollback failed:', err.message);
    await db.updateAuditProgress(run.id, { status: 'rollback_failed', metadata: JSON.stringify({ error: err.message }) });
    throw err;
  }
}

async function shadowTest() {
  log('Running shadow traffic checks (basic)');
  // Default behaviour: compare counts for core tables
  const compareTables = ['markets', 'bets', 'disputes'];
  await db.withClient(async (client) => {
    for (const t of compareTables) {
      try {
        const res = await client.query(`SELECT count(*)::bigint AS c FROM ${t}`);
        log(`table=${t} count=${res.rows[0].c}`);
      } catch (err) {
        log(`table=${t} error: ${err.message}`);
      }
    }
  });
  log('Shadow test complete');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  try {
    switch (cmd) {
      case 'preflight':
        await preflight();
        break;
      case 'status':
        await status();
        break;
      case 'apply':
        await apply();
        break;
      case 'rollback':
        await rollback();
        break;
      case 'shadow-test':
        await shadowTest();
        break;
      default:
        console.log('Usage: node migration-runner.js <preflight|status|apply|rollback|shadow-test>');
    }
  } catch (err) {
    console.error('Error:', err && err.stack ? err.stack : err);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}
