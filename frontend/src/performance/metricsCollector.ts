/**
 * @file metricsCollector.ts
 * @description Real-time performance metrics collection
 */

import { PerformanceMetric, PagePerformanceData } from './types';

export class MetricsCollector {
  private metrics: PerformanceMetric[] = [];
  private sessionId: string;
  private readonly MAX_METRICS = 5000;

  constructor(sessionId: string = this.generateSessionId()) {
    this.sessionId = sessionId;
    this.initializeWebVitals();
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Initialize Web Vitals monitoring
   */
  private initializeWebVitals(): void {
    if (typeof window === 'undefined') return;

    // First Contentful Paint (FCP) via PerformanceObserver
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            this.recordMetric({
              name: 'FCP',
              value: entry.startTime,
              unit: 'ms',
              pageUrl: window.location.href,
              tags: { type: 'core-web-vital' },
            });
          }
        }
      });
      observer.observe({ entryTypes: ['paint'] });
    } catch (e) {
      // PerformanceObserver not available
    }

    // Largest Contentful Paint (LCP)
    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        this.recordMetric({
          name: 'LCP',
          value: lastEntry.renderTime || lastEntry.loadTime,
          unit: 'ms',
          pageUrl: window.location.href,
          tags: { type: 'core-web-vital' },
        });
      });
      lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
    } catch (e) {
      // LCP not available
    }

    // Cumulative Layout Shift (CLS)
    try {
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
            this.recordMetric({
              name: 'CLS',
              value: clsValue,
              unit: '%',
              pageUrl: window.location.href,
              tags: { type: 'core-web-vital' },
            });
          }
        }
      });
      clsObserver.observe({ entryTypes: ['layout-shift'] });
    } catch (e) {
      // CLS not available
    }
  }

  /**
   * Record custom performance metric
   */
  recordMetric(metric: Omit<PerformanceMetric, 'timestamp'>): void {
    const fullMetric: PerformanceMetric = {
      ...metric,
      timestamp: new Date(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    };

    this.metrics.push(fullMetric);

    // Maintain max size
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics.shift();
    }
  }

  /**
   * Measure page load performance
   */
  measurePageLoad(): PagePerformanceData {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const paint = performance.getEntriesByType('paint');
    const resources = performance.getEntriesByType('resource');

    const fcpEntry = paint.find(p => p.name === 'first-contentful-paint');
    const lcpEntry = performance.getEntriesByType('largest-contentful-paint').pop();

    const jsHeapSize = (performance as any).memory?.usedJSHeapSize || 0;

    return {
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
      metrics: {
        fcp: fcpEntry?.startTime || 0,
        lcp: lcpEntry?.startTime || 0,
        cls: this.calculateCLS(),
        fid: this.calculateFID(),
        ttfb: navigation?.responseStart || 0,
        domContentLoaded: navigation?.domContentLoadedEventEnd || 0,
        loadComplete: navigation?.loadEventEnd || 0,
        jsHeapSize,
        resourceCount: resources.length,
      },
      timestamp: new Date(),
      sessionId: this.sessionId,
    };
  }

  /**
   * Calculate Cumulative Layout Shift
   */
  private calculateCLS(): number {
    let cls = 0;
    try {
      performance.getEntriesByType('layout-shift').forEach((entry: any) => {
        if (!entry.hadRecentInput) {
          cls += entry.value;
        }
      });
    } catch (e) {
      // CLS calculation failed
    }
    return cls;
  }

  /**
   * Calculate First Input Delay
   */
  private calculateFID(): number {
    const fidEntry = performance.getEntriesByType('first-input')[0];
    return fidEntry ? (fidEntry as any).processingDuration : 0;
  }

  /**
   * Get all collected metrics
   */
  getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Get metrics by name
   */
  getMetricsByName(name: string): PerformanceMetric[] {
    return this.metrics.filter(m => m.name === name);
  }

  /**
   * Get metrics for specific page
   */
  getMetricsForPage(pageUrl: string): PerformanceMetric[] {
    return this.metrics.filter(m => m.pageUrl === pageUrl);
  }

  /**
   * Clear metrics older than specified time
   */
  clearOldMetrics(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.metrics = this.metrics.filter(m => m.timestamp.getTime() > cutoff);
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Calculate metric statistics
   */
  getMetricStats(metricName: string): {
    min: number;
    max: number;
    avg: number;
    median: number;
    p95: number;
    p99: number;
  } {
    const values = this.metrics
      .filter(m => m.name === metricName)
      .map(m => m.value)
      .sort((a, b) => a - b);

    if (values.length === 0) {
      return { min: 0, max: 0, avg: 0, median: 0, p95: 0, p99: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const median = values[Math.floor(values.length / 2)];
    const p95Index = Math.ceil(values.length * 0.95) - 1;
    const p99Index = Math.ceil(values.length * 0.99) - 1;

    return {
      min: values[0],
      max: values[values.length - 1],
      avg,
      median,
      p95: values[Math.max(0, p95Index)],
      p99: values[Math.max(0, p99Index)],
    };
  }
}
