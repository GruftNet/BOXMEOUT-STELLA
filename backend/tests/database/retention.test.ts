/**
 * @file retention.test.ts
 * @description Unit tests for the data retention subsystem.
 *
 * The properties under test are the ones whose failure is silent and expensive:
 * data deleted against an archive that cannot be read back, PII surviving into
 * cold storage, a tampered audit trail that still verifies, and a stalled sweep
 * that no alert fires on. Throughput and ergonomics are not tested here — they
 * fail loudly on their own.
 */

import {
  Anonymizer,
  AnonymizerConfigError,
  ArchivalError,
  ArchiveManifest,
  Archiver,
  ColdStorageBackend,
  ComplianceLog,
  DEFAULT_POLICIES,
  PolicyRegistry,
  PolicyValidationError,
  Queryable,
  REDACTED,
  RetentionMonitor,
  RetentionPolicy,
  checksumOf,
  cutoffFor,
  deserializeBatch,
  validatePolicy,
} from '../../database/retention';

const KEY = 'a'.repeat(48);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-20T12:00:00.000Z');

const policyFor = (dataClass: string): RetentionPolicy =>
  DEFAULT_POLICIES.find((p) => p.dataClass === dataClass)!;

/**
 * An in-memory stand-in for a `pg` pool.
 *
 * Dispatches on query shape rather than parsing SQL. This is deliberately a
 * fake and not a mock: the archiver's safety argument is about the *order* of
 * reads, writes and deletes, and only something that actually holds state can
 * tell whether rows were still present when the delete ran.
 */
class FakeDb implements Queryable {
  readonly tables: Record<string, Record<string, unknown>[]> = {};
  readonly complianceRows: Record<string, unknown>[] = [];
  readonly manifestRows: Record<string, unknown>[] = [];
  readonly log: string[] = [];

  async query<R extends object = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.log.push(sql);

    if (sql.startsWith('SELECT entry_hash AS prev_hash')) {
      const tip = this.complianceRows[this.complianceRows.length - 1];
      return this.result(tip ? [{ prev_hash: tip.entry_hash }] : []);
    }

    if (sql.startsWith('INSERT INTO retention_compliance_log')) {
      const row = {
        id: this.complianceRows.length + 1,
        action: values[0],
        data_class: values[1],
        regime: values[2],
        row_count: values[3],
        detail: JSON.parse(values[4] as string),
        actor: values[5],
        recorded_at: values[6],
        prev_hash: values[7],
        entry_hash: values[8],
      };
      this.complianceRows.push(row);
      return this.result([{ id: row.id, recorded_at: row.recorded_at }]);
    }

    if (sql.includes('FROM retention_compliance_log') && sql.includes('ORDER BY id ASC')) {
      return this.result(this.complianceRows);
    }

    if (sql.includes("action = 'sweep_completed'")) {
      const latest = new Map<string, Date>();
      for (const row of this.complianceRows) {
        if (row.action !== 'sweep_completed' || row.data_class === null) continue;
        const at = row.recorded_at as Date;
        const seen = latest.get(row.data_class as string);
        if (!seen || at > seen) latest.set(row.data_class as string, at);
      }
      return this.result(
        [...latest].map(([data_class, last_sweep]) => ({ data_class, last_sweep })),
      );
    }

    if (sql.startsWith('INSERT INTO retention_archive_manifest')) {
      const existing = this.manifestRows.find((r) => r.object_key === values[1]);
      if (existing) {
        return this.result([existing]);
      }
      const row = {
        id: this.manifestRows.length + 1,
        data_class: values[0],
        object_key: values[1],
        checksum: values[2],
        size_bytes: String(values[3]),
        row_count: values[4],
        range_start: values[5],
        range_end: values[6],
        min_key: values[7],
        max_key: values[8],
        storage_class: values[9],
        archived_at: NOW,
        deletion_verified_at: null,
      };
      this.manifestRows.push(row);
      return this.result([row]);
    }

    if (sql.startsWith('UPDATE retention_archive_manifest')) {
      const row = this.manifestRows.find((r) => r.id === values[0]);
      if (row) row.deletion_verified_at = NOW;
      return this.result([]);
    }

    if (sql.includes('FROM retention_archive_manifest')) {
      if (sql.includes('deletion_verified_at IS NULL')) {
        return this.result(this.manifestRows.filter((r) => r.deletion_verified_at === null));
      }
      if (sql.includes('GROUP BY data_class')) {
        const byClass = new Map<string, { bytes: number; rows: number }>();
        for (const row of this.manifestRows) {
          const agg = byClass.get(row.data_class as string) ?? { bytes: 0, rows: 0 };
          agg.bytes += Number(row.size_bytes);
          agg.rows += Number(row.row_count);
          byClass.set(row.data_class as string, agg);
        }
        return this.result(
          [...byClass].map(([data_class, agg]) => ({
            data_class,
            bytes: String(agg.bytes),
            rows: String(agg.rows),
          })),
        );
      }
      return this.result(this.manifestRows);
    }

    // Capped backlog count used by the monitor.
    const capped = sql.match(/SELECT COUNT\(\*\)::text AS overdue FROM \( SELECT 1 FROM (\w+)/);
    if (capped) {
      const [, table] = capped;
      const cutoff = values[0] as Date;
      const column = sql.match(/WHERE (\w+) < \$1/)![1];
      const n = (this.tables[table] ?? []).filter(
        (r) => new Date(r[column] as string) < cutoff,
      ).length;
      return this.result([{ overdue: String(n) }]);
    }

    const remaining = sql.match(/SELECT COUNT\(\*\)::text AS remaining FROM (\w+)/);
    if (remaining) {
      const [, table] = remaining;
      const [minKey, maxKey, cutoff] = values as [string, string, Date];
      const n = (this.tables[table] ?? []).filter(
        (r) =>
          String(r.id) >= minKey &&
          String(r.id) <= maxKey &&
          new Date(r.placed_at as string) < new Date(cutoff),
      ).length;
      return this.result([{ remaining: String(n) }]);
    }

    const select = sql.match(/^SELECT \* FROM (\w+)/);
    if (select) {
      const [, table] = select;
      const cutoff = values[0] as Date;
      const limit = values[1] as number;
      const afterKey = values[2] as string | undefined;
      const column = sql.match(/WHERE (\w+) < \$1/)![1];
      const rows = (this.tables[table] ?? [])
        .filter((r) => new Date(r[column] as string) < cutoff)
        .filter((r) => (afterKey === undefined ? true : String(r.id) > afterKey))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
      return this.result(rows);
    }

    const update = sql.match(/^UPDATE (\w+) SET (.+) WHERE (\w+) = \$1/);
    if (update) {
      const [, table, assignments, keyColumn] = update;
      const columns = assignments.split(', ').map((a) => a.split(' = ')[0]);
      const row = (this.tables[table] ?? []).find((r) => r[keyColumn] === values[0]);
      columns.forEach((column, i) => {
        if (row) row[column] = values[i + 1];
      });
      return this.result([], row ? 1 : 0);
    }

    const del = sql.match(/^DELETE FROM (\w+)/);
    if (del) {
      const [, table] = del;
      const [minKey, maxKey, cutoff] = values as [string, string, string];
      const before = this.tables[table]?.length ?? 0;
      this.tables[table] = (this.tables[table] ?? []).filter(
        (r) =>
          !(
            String(r.id) >= minKey &&
            String(r.id) <= maxKey &&
            new Date(r.placed_at as string) <= new Date(cutoff)
          ),
      );
      return this.result([], before - this.tables[table].length);
    }

    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  private result<R>(rows: unknown[], rowCount?: number): { rows: R[]; rowCount: number | null } {
    return { rows: rows as R[], rowCount: rowCount ?? rows.length };
  }
}

/** Cold storage held in a Map, with hooks for corrupting what comes back out. */
class FakeStorage implements ColdStorageBackend {
  readonly storageClass = 'TEST';
  readonly objects = new Map<string, Buffer>();
  corruptOnRead = false;

  async put(key: string, payload: Buffer): Promise<void> {
    this.objects.set(key, payload);
  }

  async get(key: string): Promise<Buffer> {
    const payload = this.objects.get(key);
    if (!payload) throw new Error(`missing object ${key}`);
    return this.corruptOnRead ? Buffer.from('tampered') : payload;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function buildArchiver(db: FakeDb, storage: FakeStorage, policies: RetentionPolicy[]) {
  const registry = new PolicyRegistry(policies);
  const complianceLog = new ComplianceLog(db);
  const manifest = new ArchiveManifest(db);
  return {
    registry,
    complianceLog,
    manifest,
    archiver: new Archiver(
      db,
      storage,
      manifest,
      complianceLog,
      new Anonymizer(KEY),
      registry,
      { batchSize: 2, pauseBetweenBatchesMs: 0 },
    ),
  };
}

/** `count` bets, each one day older than the last, starting `ageDays` back. */
function seedBets(db: FakeDb, count: number, ageDays: number): void {
  db.tables.bets = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1).padStart(4, '0'),
    bettor_address: `GABC${i}`,
    amount: 100 + i,
    placed_at: new Date(NOW.getTime() - (ageDays + i) * DAY_MS).toISOString(),
  }));
}

describe('policy validation', () => {
  it('accepts every shipped default policy', () => {
    for (const policy of DEFAULT_POLICIES) {
      expect(() => validatePolicy(policy)).not.toThrow();
    }
  });

  it.each([
    ['bets; DROP TABLE bets', 'table'],
    ['Bets', 'table'],
  ])('rejects table name %p as an injection risk', (table) => {
    expect(() => validatePolicy({ ...policyFor('bets'), table })).toThrow(PolicyValidationError);
  });

  it('rejects a retention window outside the legally defensible range', () => {
    expect(() => validatePolicy({ ...policyFor('bets'), retentionDays: 7 })).toThrow(
      /outside \[30, 2555\]/,
    );
    expect(() => validatePolicy({ ...policyFor('bets'), retentionDays: 10_000 })).toThrow(
      /outside \[30, 2555\]/,
    );
  });

  it('rejects a SOX class retained under a year', () => {
    expect(() =>
      validatePolicy({ ...policyFor('bets'), retentionDays: 100, regime: 'SOX' }),
    ).toThrow(/at least 365 days/);
  });

  it('rejects anonymize_in_place with nothing to anonymize', () => {
    expect(() =>
      validatePolicy({ ...policyFor('disputes'), piiColumns: [] }),
    ).toThrow(/at least one piiColumn/);
  });

  it('excludes retain_forever classes from the sweep', () => {
    const sweepable = new PolicyRegistry().sweepable().map((p) => p.dataClass);
    expect(sweepable).not.toContain('markets');
    expect(sweepable).toContain('bets');
  });

  it('computes the cutoff by subtracting the retention window', () => {
    const cutoff = cutoffFor({ ...policyFor('bets'), retentionDays: 90 }, NOW);
    expect(cutoff.toISOString()).toBe('2026-04-21T12:00:00.000Z');
  });
});

describe('anonymizer', () => {
  const policy = policyFor('bets');

  it('refuses a key too short to resist brute force', () => {
    expect(() => new Anonymizer('short')).toThrow(AnonymizerConfigError);
    expect(() => new Anonymizer(undefined)).toThrow(AnonymizerConfigError);
  });

  it('pseudonymizes identifiers deterministically without revealing the input', () => {
    const anon = new Anonymizer(KEY);
    const a = anon.scrubRow({ bettor_address: 'GABC' }, policy);
    const b = anon.scrubRow({ bettor_address: 'GABC' }, policy);

    expect(a.bettor_address).toBe(b.bettor_address);
    expect(a.bettor_address).toMatch(/^anon_[0-9a-f]{32}$/);
    expect(String(a.bettor_address)).not.toContain('GABC');
  });

  it('produces different pseudonyms under different keys', () => {
    const row = { bettor_address: 'GABC' };
    const a = new Anonymizer(KEY).scrubRow(row, policy);
    const b = new Anonymizer('b'.repeat(48)).scrubRow(row, policy);
    expect(a.bettor_address).not.toBe(b.bettor_address);
  });

  it('redacts free text rather than pseudonymizing it', () => {
    const scrubbed = new Anonymizer(KEY).scrubRow(
      { reason: 'settled against me', admin_notes: 'contacted user' },
      policyFor('disputes'),
    );
    expect(scrubbed.reason).toBe(REDACTED);
    expect(scrubbed.admin_notes).toBe(REDACTED);
  });

  it('leaves non-PII columns and the original row untouched', () => {
    const row = { bettor_address: 'GABC', amount: 500 };
    const scrubbed = new Anonymizer(KEY).scrubRow(row, policy);

    expect(scrubbed.amount).toBe(500);
    expect(row.bettor_address).toBe('GABC');
  });

  it('passes over null PII without writing a pseudonym for it', () => {
    const scrubbed = new Anonymizer(KEY).scrubRow({ bettor_address: null }, policy);
    expect(scrubbed.bettor_address).toBeNull();
  });
});

describe('archiver: archive then delete', () => {
  it('archives, verifies and deletes every expired row', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 5, 3000);
    const { archiver, manifest } = buildArchiver(db, storage, [policyFor('bets')]);

    const result = await archiver.sweep(policyFor('bets'), NOW);

    expect(result.rowsArchived).toBe(5);
    expect(result.rowsDeleted).toBe(5);
    expect(result.unverifiedBatches).toBe(0);
    expect(result.errors).toEqual([]);
    expect(db.tables.bets).toHaveLength(0);
    expect(await manifest.unverified()).toHaveLength(0);
  });

  it('leaves rows inside the retention window alone', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 3, 10);
    const { archiver } = buildArchiver(db, storage, [policyFor('bets')]);

    const result = await archiver.sweep(policyFor('bets'), NOW);

    expect(result.rowsArchived).toBe(0);
    expect(db.tables.bets).toHaveLength(3);
    expect(storage.objects.size).toBe(0);
  });

  it('scrubs PII before the archived copy is written', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 2, 3000);
    const { archiver } = buildArchiver(db, storage, [policyFor('bets')]);

    await archiver.sweep(policyFor('bets'), NOW);

    // Decompressed, not raw bytes: the point is that the plaintext address is
    // absent from what was stored, not merely unreadable in its gzipped form.
    const archived = [...storage.objects.values()]
      .flatMap((payload) => deserializeBatch(payload))
      .map((row) => JSON.stringify(row))
      .join('');
    expect(archived).not.toContain('GABC');
    expect(archived).toContain('anon_');
  });

  it('refuses to delete when the archive reads back corrupted', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 4, 3000);
    storage.corruptOnRead = true;
    const { archiver } = buildArchiver(db, storage, [policyFor('bets')]);

    await expect(archiver.sweep(policyFor('bets'), NOW)).rejects.toThrow(ArchivalError);

    // The whole point: a bad read-back must cost nothing.
    expect(db.tables.bets).toHaveLength(4);
  });

  it('records one sweep failure without aborting the other classes', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 2, 3000);
    db.tables.oracle_reports = [
      { id: '0001', reported_at: new Date(NOW.getTime() - 900 * DAY_MS).toISOString() },
    ];
    storage.corruptOnRead = true;
    const { archiver } = buildArchiver(db, storage, [
      policyFor('bets'),
      policyFor('oracle_reports'),
    ]);

    const results = await archiver.sweepAll(NOW);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.errors.length > 0)).toBe(true);
    expect(db.complianceRows.filter((r) => r.action === 'sweep_failed')).toHaveLength(2);
  });

  it('is idempotent across a crash between archive and delete', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 2, 3000);
    const { archiver, manifest } = buildArchiver(db, storage, [policyFor('bets')]);

    await archiver.sweep(policyFor('bets'), NOW);
    const afterFirst = await manifest.search({});

    // Re-running against an already-drained table must not duplicate manifests.
    await archiver.sweep(policyFor('bets'), NOW);
    expect(await manifest.search({})).toHaveLength(afterFirst.length);
  });

  it('writes an archive that deserializes back to the original row count', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 4, 3000);
    const { archiver, manifest } = buildArchiver(db, storage, [policyFor('bets')]);

    await archiver.sweep(policyFor('bets'), NOW);

    const entries = await manifest.search({});
    const totalRows = entries.reduce((sum, e) => sum + e.rowCount, 0);
    expect(totalRows).toBe(4);
    for (const entry of entries) {
      expect(checksumOf(storage.objects.get(entry.objectKey)!)).toBe(entry.checksum);
    }
  });
});

describe('archiver: anonymize in place', () => {
  it('scrubs PII and keeps the row', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    db.tables.disputes = [
      {
        id: '0001',
        reason: 'oracle was wrong',
        admin_notes: 'refunded',
        raised_at: new Date(NOW.getTime() - 2000 * DAY_MS).toISOString(),
      },
    ];
    const { archiver } = buildArchiver(db, storage, [policyFor('disputes')]);

    const result = await archiver.sweep(policyFor('disputes'), NOW);

    expect(result.rowsAnonymized).toBe(1);
    expect(result.rowsDeleted).toBe(0);
    expect(db.tables.disputes).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
  });
});

describe('compliance log', () => {
  it('chains entries so each commits to its predecessor', async () => {
    const db = new FakeDb();
    const log = new ComplianceLog(db);

    const first = await log.record({
      action: 'sweep_started',
      dataClass: 'bets',
      regime: 'SOX',
      rowCount: null,
      detail: {},
      actor: 'test',
    });
    const second = await log.record({
      action: 'sweep_completed',
      dataClass: 'bets',
      regime: 'SOX',
      rowCount: 10,
      detail: {},
      actor: 'test',
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.entryHash);
    expect(await log.verifyChain()).toBeNull();
  });

  it('detects an edited entry', async () => {
    const db = new FakeDb();
    const log = new ComplianceLog(db);
    await log.record({
      action: 'rows_deleted',
      dataClass: 'bets',
      regime: 'SOX',
      rowCount: 100,
      detail: {},
      actor: 'test',
    });

    // Someone rewrites how many rows the sweep claimed to delete.
    db.complianceRows[0].row_count = 1;

    const broken = await log.verifyChain();
    expect(broken).not.toBeNull();
    expect(broken!.brokenAtId).toBe(1);
    expect(broken!.reason).toMatch(/does not match its recorded hash/);
  });

  it('detects a removed entry', async () => {
    const db = new FakeDb();
    const log = new ComplianceLog(db);
    for (const action of ['sweep_started', 'rows_deleted', 'sweep_completed'] as const) {
      await log.record({
        action,
        dataClass: 'bets',
        regime: 'SOX',
        rowCount: null,
        detail: {},
        actor: 'test',
      });
    }

    db.complianceRows.splice(1, 1);

    const broken = await log.verifyChain();
    expect(broken).not.toBeNull();
    expect(broken!.reason).toMatch(/removed or reordered/);
  });

  it('hashes identically regardless of detail key order', () => {
    const base = {
      action: 'archive_written' as const,
      dataClass: 'bets' as const,
      regime: 'SOX' as const,
      rowCount: 1,
      actor: 'test',
    };
    const at = new Date('2026-01-01T00:00:00.000Z');

    expect(ComplianceLog.computeHash({ ...base, detail: { a: 1, b: 2 } }, at, null)).toBe(
      ComplianceLog.computeHash({ ...base, detail: { b: 2, a: 1 } }, at, null),
    );
  });
});

describe('retention monitor', () => {
  const buildMonitor = (db: FakeDb, policies: RetentionPolicy[]) =>
    new RetentionMonitor(
      db,
      new ArchiveManifest(db),
      new ComplianceLog(db),
      new PolicyRegistry(policies),
    );

  it('reports healthy after a clean sweep', async () => {
    const db = new FakeDb();
    const storage = new FakeStorage();
    seedBets(db, 3, 3000);
    const { archiver } = buildArchiver(db, storage, [policyFor('bets')]);
    await archiver.sweep(policyFor('bets'), NOW);

    const health = await buildMonitor(db, [policyFor('bets')]).check(NOW);

    expect(health.healthy).toBe(true);
    expect(health.alerts).toEqual([]);
    expect(health.classes[0].overdueRows).toBe(0);
    expect(health.classes[0].archivedRows).toBe(3);
  });

  it('warns when a class has never been swept', async () => {
    const db = new FakeDb();
    db.tables.bets = [];

    const health = await buildMonitor(db, [policyFor('bets')]).check(NOW);

    expect(health.healthy).toBe(false);
    expect(health.alerts.map((a) => a.code)).toContain('sweep_never_ran');
  });

  it('escalates a stale sweep to critical for a GDPR class', async () => {
    const db = new FakeDb();
    db.tables.notification_jobs = [];
    const log = new ComplianceLog(db);
    await log.record({
      action: 'sweep_completed',
      dataClass: 'notification_jobs',
      regime: 'GDPR',
      rowCount: 0,
      detail: {},
      actor: 'test',
    });
    db.complianceRows[0].recorded_at = new Date(NOW.getTime() - 5 * DAY_MS);

    const health = await buildMonitor(db, [policyFor('notification_jobs')]).check(NOW);

    const stale = health.alerts.find((a) => a.code === 'sweep_stale');
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe('critical');
  });

  it('raises a critical alert for a batch archived but never confirmed deleted', async () => {
    const db = new FakeDb();
    db.tables.bets = [];
    await new ArchiveManifest(db).record({
      dataClass: 'bets',
      objectKey: 'bets/stuck',
      checksum: 'abc',
      sizeBytes: 10,
      rowCount: 5,
      rangeStart: NOW,
      rangeEnd: NOW,
      minKey: '1',
      maxKey: '5',
      storageClass: 'TEST',
    });
    db.manifestRows[0].archived_at = new Date(NOW.getTime() - 3 * DAY_MS);

    const health = await buildMonitor(db, [policyFor('bets')]).check(NOW);

    const alert = health.alerts.find((a) => a.code === 'deletion_unverified');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical');
  });

  it('does not alert on a batch archived moments ago', async () => {
    const db = new FakeDb();
    db.tables.bets = [];
    await new ArchiveManifest(db).record({
      dataClass: 'bets',
      objectKey: 'bets/in-flight',
      checksum: 'abc',
      sizeBytes: 10,
      rowCount: 5,
      rangeStart: NOW,
      rangeEnd: NOW,
      minKey: '1',
      maxKey: '5',
      storageClass: 'TEST',
    });

    const health = await buildMonitor(db, [policyFor('bets')]).check(NOW);

    expect(health.alerts.map((a) => a.code)).not.toContain('deletion_unverified');
  });

  it('surfaces a broken audit chain as critical', async () => {
    const db = new FakeDb();
    db.tables.bets = [];
    const log = new ComplianceLog(db);
    await log.record({
      action: 'sweep_completed',
      dataClass: 'bets',
      regime: 'SOX',
      rowCount: 1,
      detail: {},
      actor: 'test',
    });
    db.complianceRows[0].actor = 'someone-else';

    const health = await buildMonitor(db, [policyFor('bets')]).check(NOW);

    expect(health.chainBreak).not.toBeNull();
    expect(
      health.alerts.find((a) => a.code === 'compliance_chain_broken')!.severity,
    ).toBe('critical');
  });

  it('exports Prometheus gauges, using -1 for a class never swept', async () => {
    const db = new FakeDb();
    db.tables.bets = [];

    const text = RetentionMonitor.toPrometheus(await buildMonitor(db, [policyFor('bets')]).check(NOW));

    expect(text).toContain('retention_overdue_rows{data_class="bets"} 0');
    expect(text).toContain('retention_seconds_since_last_sweep{data_class="bets"} -1');
    expect(text).toContain('retention_compliance_chain_intact 1');
    expect(text.endsWith('\n')).toBe(true);
  });
});
