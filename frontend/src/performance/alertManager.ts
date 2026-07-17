/**
 * @file alertManager.ts
 * @description Performance alert management and notification
 */

import { PerformanceAlert, PerformanceRegressionAlert } from './types';

export interface AlertThresholds {
  fcp: number; // ms
  lcp: number; // ms
  cls: number;
  ttfb: number; // ms
  jsHeapSize: number; // bytes
}

export type AlertHandler = (alert: PerformanceAlert) => void | Promise<void>;

export class AlertManager {
  private alerts: Map<string, PerformanceAlert> = new Map();
  private thresholds: AlertThresholds;
  private handlers: Set<AlertHandler> = new Set();
  private alertId = 0;

  constructor(thresholds: Partial<AlertThresholds> = {}) {
    this.thresholds = {
      fcp: thresholds.fcp || 1800,
      lcp: thresholds.lcp || 2500,
      cls: thresholds.cls || 0.1,
      ttfb: thresholds.ttfb || 600,
      jsHeapSize: thresholds.jsHeapSize || 50 * 1024 * 1024,
    };
  }

  /**
   * Register alert handler
   */
  onAlert(handler: AlertHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Create threshold alert
   */
  createThresholdAlert(metric: string, value: number, threshold: number): PerformanceAlert {
    const severity =
      value > threshold * 1.5 ? 'critical' : value > threshold ? 'warning' : 'info';

    const alert: PerformanceAlert = {
      id: this.generateAlertId(),
      type: 'threshold',
      metric,
      pageUrl: '',
      severity,
      message: `${metric} exceeded threshold: ${value.toFixed(0)} > ${threshold.toFixed(0)}`,
      value,
      threshold,
      timestamp: new Date(),
      acknowledged: false,
    };

    return alert;
  }

  /**
   * Create regression alert
   */
  createRegressionAlert(regression: PerformanceRegressionAlert): PerformanceAlert {
    const alert: PerformanceAlert = {
      id: this.generateAlertId(),
      type: 'regression',
      metric: regression.metric,
      pageUrl: regression.pageUrl,
      severity: regression.severity,
      message: `Performance regression detected: ${regression.metric} degraded by ${regression.regressionPercent.toFixed(1)}%`,
      value: regression.currentValue,
      threshold: regression.baselineValue,
      timestamp: regression.timestamp,
      acknowledged: false,
    };

    return alert;
  }

  /**
   * Create anomaly alert
   */
  createAnomalyAlert(
    metric: string,
    value: number,
    baseline: number,
    deviation: number
  ): PerformanceAlert {
    const severity = deviation > 3 ? 'critical' : deviation > 2 ? 'warning' : 'info';

    const alert: PerformanceAlert = {
      id: this.generateAlertId(),
      type: 'anomaly',
      metric,
      pageUrl: '',
      severity,
      message: `Anomaly detected: ${metric} = ${value.toFixed(0)} (${Math.abs(deviation).toFixed(1)}σ from baseline)`,
      value,
      threshold: baseline,
      timestamp: new Date(),
      acknowledged: false,
    };

    return alert;
  }

  /**
   * Emit alert to all handlers
   */
  async emitAlert(alert: PerformanceAlert): Promise<void> {
    this.alerts.set(alert.id, alert);

    const promises = Array.from(this.handlers).map(handler =>
      Promise.resolve(handler(alert))
    );

    await Promise.all(promises);
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(alertId: string, acknowledgedBy?: string): void {
    const alert = this.alerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date();
      alert.acknowledgedBy = acknowledgedBy;
    }
  }

  /**
   * Get unacknowledged alerts
   */
  getUnacknowledgedAlerts(): PerformanceAlert[] {
    return Array.from(this.alerts.values()).filter(a => !a.acknowledged);
  }

  /**
   * Get alerts by severity
   */
  getAlertsBySeverity(severity: 'info' | 'warning' | 'critical'): PerformanceAlert[] {
    return Array.from(this.alerts.values()).filter(a => a.severity === severity);
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit: number = 50): PerformanceAlert[] {
    return Array.from(this.alerts.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Clear acknowledged alerts older than specified time
   */
  clearOldAlerts(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [id, alert] of this.alerts) {
      if (alert.acknowledged && alert.acknowledgedAt && alert.acknowledgedAt.getTime() < cutoff) {
        this.alerts.delete(id);
      }
    }
  }

  /**
   * Update alert thresholds
   */
  updateThresholds(thresholds: Partial<AlertThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Check metrics against thresholds
   */
  checkThresholds(metrics: {
    fcp?: number;
    lcp?: number;
    cls?: number;
    ttfb?: number;
    jsHeapSize?: number;
  }): PerformanceAlert[] {
    const alerts: PerformanceAlert[] = [];

    if (metrics.fcp && metrics.fcp > this.thresholds.fcp) {
      alerts.push(this.createThresholdAlert('FCP', metrics.fcp, this.thresholds.fcp));
    }

    if (metrics.lcp && metrics.lcp > this.thresholds.lcp) {
      alerts.push(this.createThresholdAlert('LCP', metrics.lcp, this.thresholds.lcp));
    }

    if (metrics.cls && metrics.cls > this.thresholds.cls) {
      alerts.push(this.createThresholdAlert('CLS', metrics.cls, this.thresholds.cls));
    }

    if (metrics.ttfb && metrics.ttfb > this.thresholds.ttfb) {
      alerts.push(this.createThresholdAlert('TTFB', metrics.ttfb, this.thresholds.ttfb));
    }

    if (metrics.jsHeapSize && metrics.jsHeapSize > this.thresholds.jsHeapSize) {
      alerts.push(
        this.createThresholdAlert(
          'JS Heap Size',
          metrics.jsHeapSize,
          this.thresholds.jsHeapSize
        )
      );
    }

    return alerts;
  }

  /**
   * Generate alert ID
   */
  private generateAlertId(): string {
    return `alert-${++this.alertId}-${Date.now()}`;
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): {
    total: number;
    unacknowledged: number;
    critical: number;
    warning: number;
    info: number;
  } {
    const all = Array.from(this.alerts.values());
    return {
      total: all.length,
      unacknowledged: all.filter(a => !a.acknowledged).length,
      critical: all.filter(a => a.severity === 'critical').length,
      warning: all.filter(a => a.severity === 'warning').length,
      info: all.filter(a => a.severity === 'info').length,
    };
  }
}
