/**
 * @file regressionDetector.ts
 * @description Automatic regression detection with configurable thresholds
 */

import {
  PerformanceRegressionAlert,
  PerformanceMetric,
  RegressionDetectionConfig,
  PerformanceTrend,
} from './types';

export class RegressionDetector {
  private config: RegressionDetectionConfig;
  private baselineMetrics: Map<string, PerformanceMetric[]> = new Map();
  private regressions: PerformanceRegressionAlert[] = [];

  constructor(config: RegressionDetectionConfig) {
    this.config = config;
  }

  /**
   * Detect regressions in current metrics vs baseline
   */
  detectRegressions(
    currentMetrics: PerformanceMetric[],
    baselineMetrics: PerformanceMetric[]
  ): PerformanceRegressionAlert[] {
    const regressions: PerformanceRegressionAlert[] = [];

    if (!this.config.enabled || baselineMetrics.length < this.config.minSampleSize) {
      return regressions;
    }

    // Group metrics by name and page
    const baselineByKey = this.groupMetrics(baselineMetrics);
    const currentByKey = this.groupMetrics(currentMetrics);

    for (const key of baselineByKey.keys()) {
      if (!currentByKey.has(key)) continue;

      const baseline = baselineByKey.get(key)!;
      const current = currentByKey.get(key)!;

      if (current.length < this.config.minSampleSize) continue;

      const baselineAvg = this.calculateAverage(baseline);
      const currentAvg = this.calculateAverage(current);

      const regressionPercent =
        ((currentAvg - baselineAvg) / baselineAvg) * 100;

      if (regressionPercent > this.config.thresholdPercent) {
        const [metric, pageUrl] = key.split('|');
        
        regressions.push({
          metric,
          pageUrl,
          baselineValue: baselineAvg,
          currentValue: currentAvg,
          regressionPercent,
          threshold: this.config.thresholdPercent,
          severity: regressionPercent > this.config.thresholdPercent * 2 ? 'critical' : 'warning',
          timestamp: new Date(),
        });
      }
    }

    this.regressions = regressions;
    return regressions;
  }

  /**
   * Group metrics by name and page for comparison
   */
  private groupMetrics(
    metrics: PerformanceMetric[]
  ): Map<string, PerformanceMetric[]> {
    const grouped = new Map<string, PerformanceMetric[]>();

    for (const metric of metrics) {
      const key = `${metric.name}|${metric.pageUrl}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(metric);
    }

    return grouped;
  }

  /**
   * Calculate average metric value
   */
  private calculateAverage(metrics: PerformanceMetric[]): number {
    if (metrics.length === 0) return 0;
    const sum = metrics.reduce((acc, m) => acc + m.value, 0);
    return sum / metrics.length;
  }

  /**
   * Calculate percentile
   */
  private calculatePercentile(
    metrics: PerformanceMetric[],
    percentile: number
  ): number {
    if (metrics.length === 0) return 0;
    const sorted = metrics.map(m => m.value).sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Analyze trend from metrics over time
   */
  analyzeTrend(metrics: PerformanceMetric[]): PerformanceTrend | null {
    if (metrics.length === 0) return null;

    const metric = metrics[0];
    const sorted = [...metrics].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    const dataPoints = this.aggregateDataPoints(sorted);
    const { trend, regression } = this.calculateTrend(dataPoints);

    return {
      metric: metric.name,
      pageUrl: metric.pageUrl,
      period: 'weekly',
      dataPoints,
      regressionDetected: regression.detected,
      regressionSeverity: regression.severity,
      trend,
    };
  }

  /**
   * Aggregate metrics into daily data points
   */
  private aggregateDataPoints(
    metrics: PerformanceMetric[]
  ): Array<{
    timestamp: Date;
    value: number;
    sampleSize: number;
    percentile95: number;
    percentile99: number;
  }> {
    const byDay = new Map<string, PerformanceMetric[]>();

    for (const metric of metrics) {
      const day = metric.timestamp.toISOString().split('T')[0];
      if (!byDay.has(day)) {
        byDay.set(day, []);
      }
      byDay.get(day)!.push(metric);
    }

    const points = [];
    for (const [day, dayMetrics] of byDay) {
      const values = dayMetrics.map(m => m.value);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const sorted = values.sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      points.push({
        timestamp: new Date(day),
        value: avg,
        sampleSize: dayMetrics.length,
        percentile95: p95 || avg,
        percentile99: p99 || avg,
      });
    }

    return points;
  }

  /**
   * Calculate trend direction and regression
   */
  private calculateTrend(
    dataPoints: Array<{
      timestamp: Date;
      value: number;
      sampleSize: number;
      percentile95: number;
      percentile99: number;
    }>
  ): {
    trend: 'improving' | 'stable' | 'degrading';
    regression: { detected: boolean; severity?: number };
  } {
    if (dataPoints.length < 2) {
      return { trend: 'stable', regression: { detected: false } };
    }

    // Simple trend detection: compare first half avg vs second half avg
    const mid = Math.floor(dataPoints.length / 2);
    const firstHalf = dataPoints.slice(0, mid).map(p => p.value);
    const secondHalf = dataPoints.slice(mid).map(p => p.value);

    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;

    let trend: 'improving' | 'stable' | 'degrading';
    let detected = false;
    let severity: number | undefined;

    if (changePercent < -5) {
      trend = 'improving';
    } else if (changePercent > 5) {
      trend = 'degrading';
      detected = true;
      severity = changePercent;
    } else {
      trend = 'stable';
    }

    return { trend, regression: { detected, severity } };
  }

  /**
   * Get latest regressions
   */
  getLatestRegressions(limit: number = 10): PerformanceRegressionAlert[] {
    return this.regressions.slice(-limit);
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<RegressionDetectionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set baseline for comparison
   */
  setBaseline(metrics: PerformanceMetric[]): void {
    const grouped = this.groupMetrics(metrics);
    this.baselineMetrics = grouped;
  }

  /**
   * Check if metric regression is critical
   */
  isCriticalRegression(alert: PerformanceRegressionAlert): boolean {
    return alert.severity === 'critical' && alert.regressionPercent > 10;
  }
}
