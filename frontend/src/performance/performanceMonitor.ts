/**
 * @file performanceMonitor.ts
 * @description Main performance monitoring orchestrator
 */

import { MetricsCollector } from './metricsCollector';
import { RegressionDetector } from './regressionDetector';
import { RecommendationEngine } from './recommendationEngine';
import { ABTestAnalyzer } from './abTestAnalyzer';
import { AlertManager } from './alertManager';
import {
  PerformanceDashboardData,
  PerformanceMetric,
  PagePerformanceData,
  RegressionDetectionConfig,
  AlertThresholds,
} from './types';

export class PerformanceMonitor {
  private collector: MetricsCollector;
  private detector: RegressionDetector;
  private recommendations: RecommendationEngine;
  private abTests: ABTestAnalyzer;
  private alerts: AlertManager;
  private reportInterval: NodeJS.Timer | null = null;
  private readonly REPORT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // Weekly

  constructor(
    regressionConfig: RegressionDetectionConfig = {
      enabled: true,
      thresholdPercent: 5,
      baselineWindow: 7 * 24 * 60 * 60 * 1000, // 7 days
      comparisonWindow: 24 * 60 * 60 * 1000, // 1 day
      minSampleSize: 30,
      metrics: ['FCP', 'LCP', 'CLS', 'TTFB'],
    },
    alertThresholds: Partial<AlertThresholds> = {}
  ) {
    this.collector = new MetricsCollector();
    this.detector = new RegressionDetector(regressionConfig);
    this.recommendations = new RecommendationEngine();
    this.abTests = new ABTestAnalyzer();
    this.alerts = new AlertManager(alertThresholds);
  }

  /**
   * Start performance monitoring
   */
  start(): void {
    if (typeof window === 'undefined') return;

    // Record initial page load
    window.addEventListener('load', () => {
      const pageData = this.collector.measurePageLoad();
      this.recordPageMetrics(pageData);
    });

    // Start periodic reporting
    this.startPeriodicReporting();
  }

  /**
   * Record page performance metrics
   */
  recordPageMetrics(pageData: PagePerformanceData): void {
    // Check against thresholds
    const thresholdAlerts = this.alerts.checkThresholds(pageData.metrics);
    thresholdAlerts.forEach(alert => this.alerts.emitAlert(alert));

    // Generate recommendations
    const recs = this.recommendations.generateRecommendations(pageData);

    // Record metrics
    Object.entries(pageData.metrics).forEach(([key, value]) => {
      this.collector.recordMetric({
        name: key.toUpperCase(),
        value,
        unit: 'ms',
        pageUrl: pageData.pageUrl,
        tags: { type: 'page-load' },
      });
    });
  }

  /**
   * Start periodic performance reporting (weekly)
   */
  private startPeriodicReporting(): void {
    if (this.reportInterval) clearInterval(this.reportInterval);

    this.reportInterval = setInterval(() => {
      this.generateWeeklyReport();
    }, this.REPORT_INTERVAL_MS);

    // Generate initial report
    setTimeout(() => this.generateWeeklyReport(), 60000); // After 1 minute
  }

  /**
   * Generate weekly performance report
   */
  private generateWeeklyReport(): void {
    const metrics = this.collector.getMetrics();
    const dashboard = this.generateDashboard(metrics);

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.log('[Performance Report]', dashboard);
    }

    // TODO: Send to analytics backend
    // await sendToBackend('/api/performance/report', dashboard);
  }

  /**
   * Generate dashboard data
   */
  generateDashboard(metrics: PerformanceMetric[]): PerformanceDashboardData {
    const fcpStats = this.collector.getMetricStats('FCP');
    const lcpStats = this.collector.getMetricStats('LCP');
    const clsStats = this.collector.getMetricStats('CLS');

    // Get unique pages
    const pages = new Set(metrics.map(m => m.pageUrl));
    const pageMetrics: PagePerformanceData[] = [];

    for (const page of pages) {
      const pageData = this.collector.getMetricsForPage(page as string);
      if (pageData.length > 0) {
        pageMetrics.push({
          pageUrl: page as string,
          metrics: {
            fcp: this.getAverage(pageData.filter(m => m.name === 'FCP').map(m => m.value)),
            lcp: this.getAverage(pageData.filter(m => m.name === 'LCP').map(m => m.value)),
            cls: this.getAverage(pageData.filter(m => m.name === 'CLS').map(m => m.value)),
            fid: 0,
            ttfb: 0,
            domContentLoaded: 0,
            loadComplete: 0,
            jsHeapSize: 0,
            resourceCount: 0,
          },
          timestamp: new Date(),
          sessionId: this.collector.getSessionId(),
        });
      }
    }

    const recommendations = this.recommendations.generateRecommendationsForPages(pageMetrics);
    const recentAlerts = this.alerts.getRecentAlerts(20);

    return {
      summary: {
        averageFCP: fcpStats.avg,
        averageLCP: lcpStats.avg,
        averageCLS: clsStats.avg,
        slowestPage: { url: '', value: 0 }, // Calculate if needed
        fastestPage: { url: '', value: 0 }, // Calculate if needed
      },
      trends: [],
      regressions: [],
      recommendations,
      alerts: recentAlerts,
      generatedAt: new Date(),
    };
  }

  /**
   * Record A/B test variant
   */
  recordABTestVariant(
    testId: string,
    variant: 'control' | 'treatment',
    metrics: PagePerformanceData
  ): void {
    if (variant === 'control') {
      this.abTests.recordControl(testId, metrics);
    } else {
      this.abTests.recordTreatment(testId, metrics);
    }
  }

  /**
   * Get A/B test results
   */
  getABTestResults(testId: string) {
    return this.abTests.getTestResults(testId);
  }

  /**
   * Register alert handler
   */
  onPerformanceAlert(handler: (alert: any) => void): () => void {
    return this.alerts.onAlert(handler);
  }

  /**
   * Get current metrics
   */
  getCurrentMetrics(): PerformanceMetric[] {
    return this.collector.getMetrics();
  }

  /**
   * Get current dashboard
   */
  getDashboard(): PerformanceDashboardData {
    return this.generateDashboard(this.collector.getMetrics());
  }

  /**
   * Get helper method
   */
  private getAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
  }
}
