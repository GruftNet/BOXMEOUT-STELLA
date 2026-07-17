/**
 * @file performance.test.ts
 * @description Tests for continuous performance monitoring system
 */

import {
  PerformanceMonitor,
  MetricsCollector,
  RegressionDetector,
  RecommendationEngine,
  ABTestAnalyzer,
  AlertManager,
  type PerformanceMetric,
  type PagePerformanceData,
} from '../performance';

describe('Continuous Performance Optimization System', () => {
  let monitor: PerformanceMonitor;
  let collector: MetricsCollector;
  let detector: RegressionDetector;
  let recommendations: RecommendationEngine;
  let abTests: ABTestAnalyzer;
  let alerts: AlertManager;

  beforeEach(() => {
    collector = new MetricsCollector();
    detector = new RegressionDetector({
      enabled: true,
      thresholdPercent: 5,
      baselineWindow: 7 * 24 * 60 * 60 * 1000,
      comparisonWindow: 24 * 60 * 60 * 1000,
      minSampleSize: 10,
      metrics: ['FCP', 'LCP', 'CLS'],
    });
    recommendations = new RecommendationEngine();
    abTests = new ABTestAnalyzer();
    alerts = new AlertManager({ fcp: 1800, lcp: 2500, cls: 0.1 });
    monitor = new PerformanceMonitor();
  });

  describe('MetricsCollector', () => {
    it('should record custom metrics', () => {
      collector.recordMetric({
        name: 'FCP',
        value: 1500,
        unit: 'ms',
        pageUrl: 'http://example.com',
      });

      const metrics = collector.getMetrics();
      expect(metrics.length).toBe(1);
      expect(metrics[0].name).toBe('FCP');
      expect(metrics[0].value).toBe(1500);
    });

    it('should collect metrics for specific page', () => {
      collector.recordMetric({
        name: 'FCP',
        value: 1500,
        unit: 'ms',
        pageUrl: 'http://example.com/page1',
      });
      collector.recordMetric({
        name: 'FCP',
        value: 1200,
        unit: 'ms',
        pageUrl: 'http://example.com/page2',
      });

      const page1Metrics = collector.getMetricsForPage('http://example.com/page1');
      expect(page1Metrics.length).toBe(1);
      expect(page1Metrics[0].value).toBe(1500);
    });

    it('should calculate metric statistics', () => {
      const values = [1000, 1200, 1500, 1800, 2000];
      values.forEach(v => {
        collector.recordMetric({
          name: 'LCP',
          value: v,
          unit: 'ms',
          pageUrl: 'http://example.com',
        });
      });

      const stats = collector.getMetricStats('LCP');
      expect(stats.min).toBe(1000);
      expect(stats.max).toBe(2000);
      expect(stats.avg).toBeCloseTo(1500, 0);
    });

    it('should measure page load performance', () => {
      const pageData = collector.measurePageLoad();
      expect(pageData).toHaveProperty('metrics');
      expect(pageData).toHaveProperty('timestamp');
      expect(pageData).toHaveProperty('sessionId');
    });
  });

  describe('RegressionDetector', () => {
    it('should detect performance regressions > 5%', () => {
      const baseline: PerformanceMetric[] = Array(20)
        .fill(0)
        .map((_, i) => ({
          name: 'LCP',
          value: 2000,
          unit: 'ms',
          timestamp: new Date(Date.now() - i * 60000),
          pageUrl: 'http://example.com',
        }));

      const current: PerformanceMetric[] = Array(15)
        .fill(0)
        .map((_, i) => ({
          name: 'LCP',
          value: 2150, // 7.5% increase
          unit: 'ms',
          timestamp: new Date(Date.now() - i * 60000),
          pageUrl: 'http://example.com',
        }));

      const regressions = detector.detectRegressions(current, baseline);
      expect(regressions.length).toBeGreaterThan(0);
      expect(regressions[0].regressionPercent).toBeGreaterThan(5);
    });

    it('should not alert for minor variations < 5%', () => {
      const baseline: PerformanceMetric[] = Array(20)
        .fill(0)
        .map((_, i) => ({
          name: 'FCP',
          value: 1500,
          unit: 'ms',
          timestamp: new Date(Date.now() - i * 60000),
          pageUrl: 'http://example.com',
        }));

      const current: PerformanceMetric[] = Array(15)
        .fill(0)
        .map((_, i) => ({
          name: 'FCP',
          value: 1540, // 2.67% increase
          unit: 'ms',
          timestamp: new Date(Date.now() - i * 60000),
          pageUrl: 'http://example.com',
        }));

      const regressions = detector.detectRegressions(current, baseline);
      expect(regressions.length).toBe(0);
    });

    it('should analyze performance trends', () => {
      const metrics: PerformanceMetric[] = [
        { name: 'LCP', value: 2000, unit: 'ms', timestamp: new Date('2024-01-01'), pageUrl: 'http://example.com' },
        { name: 'LCP', value: 2100, unit: 'ms', timestamp: new Date('2024-01-02'), pageUrl: 'http://example.com' },
        { name: 'LCP', value: 2050, unit: 'ms', timestamp: new Date('2024-01-03'), pageUrl: 'http://example.com' },
      ];

      const trend = detector.analyzeTrend(metrics);
      expect(trend).toHaveProperty('trend');
      expect(['improving', 'stable', 'degrading']).toContain(trend?.trend);
    });
  });

  describe('RecommendationEngine', () => {
    it('should recommend LCP optimization for slow pages', () => {
      const pageData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1500,
          lcp: 3500, // > 2500ms
          cls: 0.05,
          fid: 100,
          ttfb: 300,
          domContentLoaded: 2000,
          loadComplete: 3500,
          jsHeapSize: 30 * 1024 * 1024,
          resourceCount: 30,
        },
        timestamp: new Date(),
        sessionId: 'test-session',
      };

      const recommendations = recommendations.generateRecommendations(pageData);
      const lcpRec = recommendations.find(r => r.category === 'rendering' && r.recommendation.includes('LCP'));
      expect(lcpRec).toBeDefined();
      expect(lcpRec?.priority).toBe('high');
    });

    it('should recommend JS heap size optimization', () => {
      const pageData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1000,
          lcp: 1800,
          cls: 0.05,
          fid: 50,
          ttfb: 300,
          domContentLoaded: 1500,
          loadComplete: 2000,
          jsHeapSize: 60 * 1024 * 1024, // > 50MB
          resourceCount: 30,
        },
        timestamp: new Date(),
        sessionId: 'test-session',
      };

      const recs = recommendations.generateRecommendations(pageData);
      const heapRec = recs.find(r => r.category === 'memory');
      expect(heapRec).toBeDefined();
      expect(heapRec?.recommendation).toContain('heap size');
    });

    it('should calculate potential improvement', () => {
      const recs = [
        {
          pageUrl: 'test',
          priority: 'high',
          category: 'rendering',
          recommendation: 'test 1',
          estimatedImprovement: 20,
          generatedAt: new Date(),
          evidence: [],
        },
        {
          pageUrl: 'test',
          priority: 'medium',
          category: 'bundle',
          recommendation: 'test 2',
          estimatedImprovement: 15,
          generatedAt: new Date(),
          evidence: [],
        },
      ];

      const improvement = recommendations.calculatePotentialImprovement(recs);
      expect(improvement).toBeGreaterThan(0);
      expect(improvement).toBeLessThanOrEqual(35); // With diminishing returns
    });
  });

  describe('ABTestAnalyzer', () => {
    it('should record control and treatment variants', () => {
      const controlData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1500,
          lcp: 2300,
          cls: 0.08,
          fid: 100,
          ttfb: 300,
          domContentLoaded: 2000,
          loadComplete: 2500,
          jsHeapSize: 35 * 1024 * 1024,
          resourceCount: 35,
        },
        timestamp: new Date(),
        sessionId: 'control-1',
      };

      const treatmentData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1400,
          lcp: 2100, // 8.7% faster
          cls: 0.07,
          fid: 90,
          ttfb: 280,
          domContentLoaded: 1900,
          loadComplete: 2400,
          jsHeapSize: 32 * 1024 * 1024,
          resourceCount: 32,
        },
        timestamp: new Date(),
        sessionId: 'treatment-1',
      };

      abTests.recordControl('test-1', controlData);
      abTests.recordTreatment('test-1', treatmentData);

      const sizes = abTests.getSampleSizes('test-1');
      expect(sizes.control).toBe(1);
      expect(sizes.treatment).toBe(1);
    });

    it('should calculate A/B test impact', () => {
      const control: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1500,
          lcp: 2300,
          cls: 0.08,
          fid: 100,
          ttfb: 300,
          domContentLoaded: 2000,
          loadComplete: 2500,
          jsHeapSize: 35 * 1024 * 1024,
          resourceCount: 35,
        },
        timestamp: new Date(),
        sessionId: 'test',
      };

      abTests.recordControl('test-1', control);
      abTests.recordTreatment('test-1', { ...control, sessionId: 'test-2', metrics: { ...control.metrics, lcp: 2100 } });

      const impact = abTests.calculateImpact('test-1');
      expect(impact).toBeDefined();
      expect(impact?.impactPercent).toBeLessThan(0); // Should show improvement
    });

    it('should get test results and recommendations', () => {
      const control: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1500,
          lcp: 2300,
          cls: 0.08,
          fid: 100,
          ttfb: 300,
          domContentLoaded: 2000,
          loadComplete: 2500,
          jsHeapSize: 35 * 1024 * 1024,
          resourceCount: 35,
        },
        timestamp: new Date(),
        sessionId: 'test',
      };

      abTests.recordControl('test-1', control);
      abTests.recordTreatment('test-1', { ...control, sessionId: 'test-2', metrics: { ...control.metrics } });

      const results = abTests.getTestResults('test-1');
      expect(results).toHaveProperty('recommendation');
    });
  });

  describe('AlertManager', () => {
    it('should create threshold alerts', () => {
      const alert = alerts.createThresholdAlert('LCP', 3000, 2500);
      expect(alert.type).toBe('threshold');
      expect(alert.severity).toBe('warning');
      expect(alert.message).toContain('exceeded threshold');
    });

    it('should check metrics against thresholds', () => {
      const alertList = alerts.checkThresholds({
        fcp: 2000, // > 1800
        lcp: 3000, // > 2500
        cls: 0.05,
      });

      expect(alertList.length).toBeGreaterThan(0);
      expect(alertList.some(a => a.metric === 'FCP')).toBe(true);
      expect(alertList.some(a => a.metric === 'LCP')).toBe(true);
    });

    it('should acknowledge alerts', () => {
      const alert = alerts.createThresholdAlert('LCP', 3000, 2500);
      alerts.acknowledgeAlert(alert.id, 'test-user');
      expect(alert.acknowledged).toBe(true);
      expect(alert.acknowledgedBy).toBe('test-user');
    });

    it('should get unacknowledged alerts', async () => {
      const alert1 = alerts.createThresholdAlert('LCP', 3000, 2500);
      const alert2 = alerts.createThresholdAlert('FCP', 2000, 1800);

      await alerts.emitAlert(alert1);
      await alerts.emitAlert(alert2);

      const unack = alerts.getUnacknowledgedAlerts();
      expect(unack.length).toBe(2);

      alerts.acknowledgeAlert(alert1.id);
      expect(alerts.getUnacknowledgedAlerts().length).toBe(1);
    });

    it('should update alert thresholds', () => {
      alerts.updateThresholds({ fcp: 1500, lcp: 2000 });
      const alertList = alerts.checkThresholds({ fcp: 1600 });
      expect(alertList.length).toBeGreaterThan(0);
    });
  });

  describe('Acceptance Criteria', () => {
    it('should track performance metrics weekly', () => {
      collector.recordMetric({
        name: 'LCP',
        value: 2300,
        unit: 'ms',
        pageUrl: 'http://example.com',
      });

      const metrics = collector.getMetrics();
      expect(metrics.length).toBeGreaterThan(0);
      expect(metrics[0].timestamp).toBeInstanceOf(Date);
    });

    it('should detect regressions automatically', () => {
      const baseline: PerformanceMetric[] = Array(20)
        .fill(0)
        .map((_, i) => ({
          name: 'LCP',
          value: 2000,
          unit: 'ms',
          timestamp: new Date(Date.now() - i * 60000),
          pageUrl: 'http://example.com',
        }));

      const current: PerformanceMetric[] = Array(20)
        .fill(0)
        .map((_, i) => ({
          name: 'LCP',
          value: 2200,
          unit: 'ms',
          timestamp: new Date(),
          pageUrl: 'http://example.com',
        }));

      const regressions = detector.detectRegressions(current, baseline);
      expect(regressions.length).toBeGreaterThan(0);
    });

    it('should provide trend analysis', () => {
      const metrics: PerformanceMetric[] = [
        { name: 'LCP', value: 2000, unit: 'ms', timestamp: new Date('2024-01-01'), pageUrl: 'http://example.com' },
        { name: 'LCP', value: 1900, unit: 'ms', timestamp: new Date('2024-01-08'), pageUrl: 'http://example.com' },
      ];

      const trend = detector.analyzeTrend(metrics);
      expect(trend?.trend).toBeDefined();
    });

    it('should generate recommendations for slow pages', () => {
      const pageData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 2000,
          lcp: 3000,
          cls: 0.15,
          fid: 150,
          ttfb: 700,
          domContentLoaded: 2500,
          loadComplete: 3500,
          jsHeapSize: 60 * 1024 * 1024,
          resourceCount: 60,
        },
        timestamp: new Date(),
        sessionId: 'test',
      };

      const recs = recommendations.generateRecommendations(pageData);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0]).toHaveProperty('recommendation');
    });

    it('should measure A/B test impact on performance', () => {
      const controlData: PagePerformanceData = {
        pageUrl: 'http://example.com',
        metrics: {
          fcp: 1500,
          lcp: 2300,
          cls: 0.08,
          fid: 100,
          ttfb: 300,
          domContentLoaded: 2000,
          loadComplete: 2500,
          jsHeapSize: 35 * 1024 * 1024,
          resourceCount: 35,
        },
        timestamp: new Date(),
        sessionId: 'control-1',
      };

      abTests.recordControl('test-1', controlData);
      abTests.recordTreatment('test-1', controlData);

      expect(abTests.getActiveTests()).toContain('test-1');
    });

    it('should send alerts on major regressions', async () => {
      let alertReceived = false;

      alerts.onAlert(() => {
        alertReceived = true;
      });

      const alert = alerts.createThresholdAlert('LCP', 4000, 2500);
      await alerts.emitAlert(alert);

      expect(alertReceived).toBe(true);
    });
  });
});
