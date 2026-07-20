/**
 * @file monitor.ts
 * @description Health and alerting surface for the retention subsystem.
 */

import { ComplianceLog, Queryable } from './compliance-log';
import { ArchiveManifest } from './manifest';
import { PolicyRegistry, cutoffFor } from './policies';
import { DataClass, RetentionPolicy } from './types';

/**
 * Backlog counts are capped rather than exact.
 *
 * An exact `COUNT(*)` over an unswept class is a full scan of everything the
 * sweep has not yet reached — the query gets slower precisely as the situation
 * gets worse, which is the wrong direction for a health check that pages
 * someone. The cap answers the only question monitoring actually asks: is the
 * backlog small, or is it large enough to alert on?
 */
const BACKLOG_CAP = 100_000;

/** A sweep is considered stale once it has not completed within this window. */
const SWEEP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/** How long an archived batch may sit without provable deletion before alerting. */
const UNVERIFIED_STALE_AFTER_MS = 60 * 60 * 1000;

export type AlertSeverity = 'critical' | 'warning';

export interface RetentionAlert {
  severity: AlertSeverity;
  /** Stable identifier, safe to route or deduplicate on. */
  code:
    | 'compliance_chain_broken'
    | 'deletion_unverified'
    | 'sweep_stale'
    | 'sweep_never_ran'
    | 'backlog_exceeds_cap';
  dataClass: DataClass | null;
  message: string;
}

export interface ClassHealth {
  dataClass: DataClass;
  action: RetentionPolicy['action'];
  regime: RetentionPolicy['regime'];
  retentionDays: number;
  /** Rows past their retention window, capped at {@link BACKLOG_CAP}. */
  overdueRows: number;
  /** True when the real backlog may exceed the reported, capped figure. */
  overdueCapped: boolean;
  lastSweepAt: Date | null;
  archivedBytes: number;
  archivedRows: number;
  unverifiedBatches: number;
}

export interface RetentionHealth {
  checkedAt: Date;
  healthy: boolean;
  classes: ClassHealth[];
  /** Non-null when the audit trail's hash chain fails verification. */
  chainBreak: { brokenAtId: number; reason: string } | null;
  totalArchivedBytes: number;
  alerts: RetentionAlert[];
}

/**
 * Reports on whether the retention subsystem is actually keeping its promises.
 *
 * The distinction that matters here: the {@link import('./archiver').Archiver}
 * reports what one run did, this reports what the *state of the world* is. A
 * sweep that returns clean results every time is worthless if it stopped being
 * scheduled a month ago, and only a standing check notices that.
 */
export class RetentionMonitor {
  constructor(
    private readonly db: Queryable,
    private readonly manifest: ArchiveManifest,
    private readonly complianceLog: ComplianceLog,
    private readonly registry: PolicyRegistry,
  ) {}

  /**
   * Counts rows past their cutoff, stopping at the cap.
   *
   * The `LIMIT` lives inside the subquery so Postgres can stop scanning once it
   * has enough rows; counting the outer set then costs at most `BACKLOG_CAP`
   * rows regardless of how far behind the sweep has fallen.
   */
  private async overdueCount(policy: RetentionPolicy, now: Date): Promise<number> {
    const { rows } = await this.db.query<{ overdue: string }>(
      `SELECT COUNT(*)::text AS overdue
         FROM (
           SELECT 1 FROM ${policy.table}
            WHERE ${policy.timestampColumn} < $1
            LIMIT ${BACKLOG_CAP}
         ) capped`,
      [cutoffFor(policy, now)],
    );
    return Number(rows[0]?.overdue ?? '0');
  }

  /**
   * Last successful sweep per class, read from the audit trail rather than from
   * in-process state so a restarted or relocated worker cannot make a stalled
   * sweep look healthy.
   */
  private async lastSweepTimes(): Promise<Map<string, Date>> {
    const { rows } = await this.db.query<{ data_class: string; last_sweep: string }>(
      `SELECT data_class, MAX(recorded_at) AS last_sweep
         FROM retention_compliance_log
        WHERE action = 'sweep_completed'
          AND data_class IS NOT NULL
        GROUP BY data_class`,
    );
    return new Map(rows.map((row) => [row.data_class, new Date(row.last_sweep)]));
  }

  /**
   * Builds a full health snapshot.
   *
   * Every check runs even when an earlier one has already failed: an operator
   * responding to a page needs the whole picture, and a broken hash chain must
   * not mask a growing backlog underneath it.
   */
  async check(now: Date = new Date()): Promise<RetentionHealth> {
    const [chainBreak, unverified, storage, lastSweeps] = await Promise.all([
      this.complianceLog.verifyChain(),
      this.manifest.unverified(),
      this.manifest.storageSummary(),
      this.lastSweepTimes(),
    ]);

    const storageByClass = new Map(storage.map((s) => [s.dataClass, s]));
    const unverifiedByClass = new Map<DataClass, number>();
    for (const entry of unverified) {
      unverifiedByClass.set(entry.dataClass, (unverifiedByClass.get(entry.dataClass) ?? 0) + 1);
    }

    const alerts: RetentionAlert[] = [];
    const classes: ClassHealth[] = [];

    for (const policy of this.registry.sweepable()) {
      const overdueRows = await this.overdueCount(policy, now);
      const lastSweepAt = lastSweeps.get(policy.dataClass) ?? null;
      const archived = storageByClass.get(policy.dataClass);

      classes.push({
        dataClass: policy.dataClass,
        action: policy.action,
        regime: policy.regime,
        retentionDays: policy.retentionDays,
        overdueRows,
        overdueCapped: overdueRows >= BACKLOG_CAP,
        lastSweepAt,
        archivedBytes: archived?.bytes ?? 0,
        archivedRows: archived?.rows ?? 0,
        unverifiedBatches: unverifiedByClass.get(policy.dataClass) ?? 0,
      });

      if (lastSweepAt === null) {
        alerts.push({
          severity: 'warning',
          code: 'sweep_never_ran',
          dataClass: policy.dataClass,
          message: `no completed sweep recorded for "${policy.dataClass}"`,
        });
      } else if (now.getTime() - lastSweepAt.getTime() > SWEEP_STALE_AFTER_MS) {
        // A stale sweep on a GDPR class means data is being held past the window
        // the platform committed to, which is a compliance breach rather than a
        // backlog. Severity follows the regime for that reason.
        alerts.push({
          severity: policy.regime === 'GDPR' ? 'critical' : 'warning',
          code: 'sweep_stale',
          dataClass: policy.dataClass,
          message:
            `last sweep of "${policy.dataClass}" completed ${lastSweepAt.toISOString()}, ` +
            `beyond the ${SWEEP_STALE_AFTER_MS / 3_600_000}h threshold`,
        });
      }

      if (overdueRows >= BACKLOG_CAP) {
        alerts.push({
          severity: 'warning',
          code: 'backlog_exceeds_cap',
          dataClass: policy.dataClass,
          message:
            `"${policy.dataClass}" has at least ${BACKLOG_CAP} rows past retention; ` +
            'the sweep is not keeping pace with ingest',
        });
      }
    }

    if (chainBreak) {
      alerts.push({
        severity: 'critical',
        code: 'compliance_chain_broken',
        dataClass: null,
        message: `compliance log hash chain broken at entry ${chainBreak.brokenAtId}: ${chainBreak.reason}`,
      });
    }

    // Only alert on batches that have had time to settle. A sweep in flight will
    // briefly hold unverified manifests by design, and paging on those would
    // train operators to ignore the alert that catches the real case: data
    // living in both tiers indefinitely.
    const stuck = unverified.filter(
      (entry) => now.getTime() - entry.archivedAt.getTime() > UNVERIFIED_STALE_AFTER_MS,
    );
    for (const entry of stuck) {
      alerts.push({
        severity: 'critical',
        code: 'deletion_unverified',
        dataClass: entry.dataClass,
        message:
          `manifest ${entry.id} (${entry.objectKey}) archived ${entry.archivedAt.toISOString()} ` +
          'but its source rows are still not provably deleted',
      });
    }

    return {
      checkedAt: now,
      healthy: alerts.length === 0,
      classes,
      chainBreak,
      totalArchivedBytes: storage.reduce((sum, s) => sum + s.bytes, 0),
      alerts,
    };
  }

  /**
   * Renders a snapshot as Prometheus text exposition.
   *
   * Emitted as plain text rather than through `prom-client` registers because
   * these are point-in-time gauges derived from queries, not counters the
   * process accumulates — a scrape should reflect the database's state at scrape
   * time, not whatever the last in-process sweep happened to leave behind.
   */
  static toPrometheus(health: RetentionHealth): string {
    const lines: string[] = [
      '# HELP retention_overdue_rows Rows past their retention window (capped).',
      '# TYPE retention_overdue_rows gauge',
    ];

    for (const c of health.classes) {
      lines.push(`retention_overdue_rows{data_class="${c.dataClass}"} ${c.overdueRows}`);
    }

    lines.push(
      '# HELP retention_unverified_batches Archived batches whose deletion is unconfirmed.',
      '# TYPE retention_unverified_batches gauge',
    );
    for (const c of health.classes) {
      lines.push(
        `retention_unverified_batches{data_class="${c.dataClass}"} ${c.unverifiedBatches}`,
      );
    }

    lines.push(
      '# HELP retention_seconds_since_last_sweep Age of the last completed sweep.',
      '# TYPE retention_seconds_since_last_sweep gauge',
    );
    for (const c of health.classes) {
      // -1 rather than 0 or a missing series: a class that has never swept is a
      // distinct condition from one swept a moment ago, and a gap in the series
      // would let the alert rule silently match nothing.
      const seconds =
        c.lastSweepAt === null
          ? -1
          : Math.floor((health.checkedAt.getTime() - c.lastSweepAt.getTime()) / 1000);
      lines.push(`retention_seconds_since_last_sweep{data_class="${c.dataClass}"} ${seconds}`);
    }

    lines.push(
      '# HELP retention_archived_bytes Bytes held in cold storage per class.',
      '# TYPE retention_archived_bytes gauge',
    );
    for (const c of health.classes) {
      lines.push(`retention_archived_bytes{data_class="${c.dataClass}"} ${c.archivedBytes}`);
    }

    lines.push(
      '# HELP retention_compliance_chain_intact 1 when the audit hash chain verifies.',
      '# TYPE retention_compliance_chain_intact gauge',
      `retention_compliance_chain_intact ${health.chainBreak ? 0 : 1}`,
    );

    return `${lines.join('\n')}\n`;
  }
}
