/**
 * @file types.ts
 * @description Performance monitoring type definitions
 */

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count' | '%';
  timestamp: Date;
  pageUrl: string;
  userAgent?: string;
  tags?: Record<string, string>;
}

export interface PagePerformanceData {
  pageUrl: string;
  metrics: {
    fcp: number; // First Contentful Paint (ms)
    lcp: number; // Largest Contentful Paint (ms)
    cls: number; // Cumulative Layout Shift
    fid: number; // First Input Delay (ms)
    ttfb: number; // Time to First Byte (ms)
    domContentLoaded: number; // (ms)
    loadComplete: number; // (ms)
    jsHeapSize: number; // (bytes)
    resourceCount: number;
  };
  timestamp: Date;
  sessionId: string;
  userId?: string;
}

export interface PerformanceRegressionAlert {
  metric: string;
  pageUrl: string;
  baselineValue: number;
  currentValue: number;
  regressionPercent: number;
  threshold: number;
  severity: 'warning' | 'critical';
  timestamp: Date;
}

export interface OptimizationRecommendation {
  pageUrl: string;
  priority: 'high' | 'medium' | 'low';
  category: 'bundle' | 'rendering' | 'network' | 'memory' | 'asset';
  recommendation: string;
  estimatedImprovement: number; // percentage
  generatedAt: Date;
  evidence: string[];
}

export interface PerformanceTrend {
  metric: string;
  pageUrl: string;
  period: 'daily' | 'weekly' | 'monthly';
  dataPoints: TrendDataPoint[];
  regressionDetected: boolean;
  regressionSeverity?: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface TrendDataPoint {
  timestamp: Date;
  value: number;
  sampleSize: number;
  percentile95: number;
  percentile99: number;
}

export interface ABTestPerformanceImpact {
  testId: string;
  variant: 'control' | 'treatment';
  metrics: {
    fcp: number;
    lcp: number;
    cls: number;
    jsHeapSize: number;
  };
  sampleSize: number;
  confidence: number; // 0-1
  impactPercent: number;
  statisticallySignificant: boolean;
  timestamp: Date;
}

export interface PerformanceAlert {
  id: string;
  type: 'regression' | 'threshold' | 'anomaly';
  metric: string;
  pageUrl: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
}

export interface PerformanceDashboardData {
  summary: {
    averageFCP: number;
    averageLCP: number;
    averageCLS: number;
    slowestPage: { url: string; value: number };
    fastestPage: { url: string; value: number };
  };
  trends: PerformanceTrend[];
  regressions: PerformanceRegressionAlert[];
  recommendations: OptimizationRecommendation[];
  alerts: PerformanceAlert[];
  generatedAt: Date;
}

export interface RegressionDetectionConfig {
  enabled: boolean;
  thresholdPercent: number; // e.g., 5 for 5% regression
  baselineWindow: number; // milliseconds
  comparisonWindow: number; // milliseconds
  minSampleSize: number;
  metrics: string[]; // which metrics to monitor
}
