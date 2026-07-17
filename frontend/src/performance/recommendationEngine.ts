/**
 * @file recommendationEngine.ts
 * @description Automated optimization recommendations based on metrics
 */

import { OptimizationRecommendation, PagePerformanceData, PerformanceMetric } from './types';

export class RecommendationEngine {
  /**
   * Generate optimization recommendations from metrics
   */
  generateRecommendations(pageData: PagePerformanceData): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];
    const { metrics, pageUrl } = pageData;

    // LCP > 2.5s recommendation
    if (metrics.lcp > 2500) {
      recommendations.push({
        pageUrl,
        priority: metrics.lcp > 4000 ? 'high' : 'medium',
        category: 'rendering',
        recommendation: 'Optimize Largest Contentful Paint (LCP) - consider lazy loading and image optimization',
        estimatedImprovement: 20,
        generatedAt: new Date(),
        evidence: [`LCP: ${metrics.lcp.toFixed(0)}ms (target: <2.5s)`],
      });
    }

    // FCP > 1.8s recommendation
    if (metrics.fcp > 1800) {
      recommendations.push({
        pageUrl,
        priority: metrics.fcp > 3000 ? 'high' : 'medium',
        category: 'rendering',
        recommendation: 'Reduce First Contentful Paint (FCP) - eliminate render-blocking resources',
        estimatedImprovement: 15,
        generatedAt: new Date(),
        evidence: [`FCP: ${metrics.fcp.toFixed(0)}ms (target: <1.8s)`],
      });
    }

    // CLS > 0.1 recommendation
    if (metrics.cls > 0.1) {
      recommendations.push({
        pageUrl,
        priority: 'high',
        category: 'rendering',
        recommendation: 'Improve Cumulative Layout Shift (CLS) - reserve space for dynamic content',
        estimatedImprovement: 25,
        generatedAt: new Date(),
        evidence: [`CLS: ${metrics.cls.toFixed(3)} (target: <0.1)`],
      });
    }

    // TTFB > 600ms recommendation
    if (metrics.ttfb > 600) {
      recommendations.push({
        pageUrl,
        priority: 'high',
        category: 'network',
        recommendation: 'Improve Time to First Byte (TTFB) - optimize server response time or use CDN',
        estimatedImprovement: 30,
        generatedAt: new Date(),
        evidence: [`TTFB: ${metrics.ttfb.toFixed(0)}ms (target: <600ms)`],
      });
    }

    // JS Heap Size recommendation
    if (metrics.jsHeapSize > 50 * 1024 * 1024) {
      // > 50MB
      recommendations.push({
        pageUrl,
        priority: 'medium',
        category: 'memory',
        recommendation: 'Reduce JavaScript heap size - consider code splitting and bundle optimization',
        estimatedImprovement: 20,
        generatedAt: new Date(),
        evidence: [
          `JS Heap: ${(metrics.jsHeapSize / 1024 / 1024).toFixed(1)}MB (recommend: <50MB)`,
        ],
      });
    }

    // Resource count recommendation
    if (metrics.resourceCount > 50) {
      recommendations.push({
        pageUrl,
        priority: 'medium',
        category: 'asset',
        recommendation: 'Reduce resource count - consolidate requests and remove unused resources',
        estimatedImprovement: 15,
        generatedAt: new Date(),
        evidence: [`Resources: ${metrics.resourceCount} (recommend: <50)`],
      });
    }

    // Page load time recommendation
    const pageLoadTime = metrics.loadComplete - metrics.loadComplete + metrics.loadComplete;
    if (pageLoadTime > 3000) {
      recommendations.push({
        pageUrl,
        priority: 'high',
        category: 'bundle',
        recommendation: 'Optimize overall page load - implement aggressive caching and code splitting',
        estimatedImprovement: 25,
        generatedAt: new Date(),
        evidence: [`Load time: ${pageLoadTime.toFixed(0)}ms (target: <3s)`],
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Generate recommendations for multiple pages
   */
  generateRecommendationsForPages(
    pageDataList: PagePerformanceData[]
  ): OptimizationRecommendation[] {
    const allRecommendations = pageDataList.flatMap(data =>
      this.generateRecommendations(data)
    );

    // Deduplicate and sort by impact
    const uniqueRecommendations = new Map<string, OptimizationRecommendation>();
    for (const rec of allRecommendations) {
      const key = `${rec.pageUrl}|${rec.category}|${rec.recommendation}`;
      if (!uniqueRecommendations.has(key)) {
        uniqueRecommendations.set(key, rec);
      }
    }

    return Array.from(uniqueRecommendations.values()).sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.estimatedImprovement - a.estimatedImprovement;
    });
  }

  /**
   * Analyze metric trends to generate proactive recommendations
   */
  analyzeMetricTrends(metrics: PerformanceMetric[]): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    // Group by metric name
    const byMetric = new Map<string, PerformanceMetric[]>();
    for (const m of metrics) {
      if (!byMetric.has(m.name)) {
        byMetric.set(m.name, []);
      }
      byMetric.get(m.name)!.push(m);
    }

    // Check for increasing trends
    for (const [metricName, metricValues] of byMetric) {
      if (metricValues.length < 5) continue;

      const sorted = metricValues
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .map(m => m.value);

      const recent = sorted.slice(-5);
      const older = sorted.slice(-10, -5);

      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

      const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;

      if (changePercent > 5) {
        recommendations.push({
          pageUrl: metricValues[0].pageUrl,
          priority: changePercent > 15 ? 'high' : 'medium',
          category: 'bundle',
          recommendation: `${metricName} is degrading (${changePercent.toFixed(1)}% increase) - investigate root cause`,
          estimatedImprovement: Math.min(changePercent, 50),
          generatedAt: new Date(),
          evidence: [`${metricName} trend shows ${changePercent.toFixed(1)}% increase`],
        });
      }
    }

    return recommendations;
  }

  /**
   * Get recommendations by category
   */
  getRecommendationsByCategory(
    recommendations: OptimizationRecommendation[]
  ): Map<string, OptimizationRecommendation[]> {
    const byCategory = new Map<string, OptimizationRecommendation[]>();

    for (const rec of recommendations) {
      if (!byCategory.has(rec.category)) {
        byCategory.set(rec.category, []);
      }
      byCategory.get(rec.category)!.push(rec);
    }

    return byCategory;
  }

  /**
   * Calculate potential performance improvement from recommendations
   */
  calculatePotentialImprovement(recommendations: OptimizationRecommendation[]): number {
    if (recommendations.length === 0) return 0;

    // Cumulative improvement with diminishing returns
    let totalImprovement = 0;
    for (let i = 0; i < recommendations.length; i++) {
      const improvement = recommendations[i].estimatedImprovement;
      const diminishing = Math.pow(0.9, i); // 10% reduction per item
      totalImprovement += improvement * diminishing;
    }

    return Math.round(totalImprovement);
  }
}
