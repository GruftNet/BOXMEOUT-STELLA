/**
 * @file index.ts
 * @description Performance monitoring system exports
 */

export { PerformanceMonitor } from './performanceMonitor';
export { MetricsCollector } from './metricsCollector';
export { RegressionDetector } from './regressionDetector';
export { RecommendationEngine } from './recommendationEngine';
export { ABTestAnalyzer } from './abTestAnalyzer';
export { AlertManager } from './alertManager';

export type {
  PerformanceMetric,
  PagePerformanceData,
  PerformanceRegressionAlert,
  OptimizationRecommendation,
  PerformanceTrend,
  TrendDataPoint,
  ABTestPerformanceImpact,
  PerformanceAlert,
  PerformanceDashboardData,
  RegressionDetectionConfig,
} from './types';

export type { AlertThresholds } from './alertManager';
