/**
 * @file abTestAnalyzer.ts
 * @description A/B test performance impact measurement
 */

import { ABTestPerformanceImpact, PagePerformanceData } from './types';

export class ABTestAnalyzer {
  private controlGroups: Map<string, PagePerformanceData[]> = new Map();
  private treatmentGroups: Map<string, PagePerformanceData[]> = new Map();

  /**
   * Record control variant metrics
   */
  recordControl(testId: string, metrics: PagePerformanceData): void {
    if (!this.controlGroups.has(testId)) {
      this.controlGroups.set(testId, []);
    }
    this.controlGroups.get(testId)!.push(metrics);
  }

  /**
   * Record treatment variant metrics
   */
  recordTreatment(testId: string, metrics: PagePerformanceData): void {
    if (!this.treatmentGroups.has(testId)) {
      this.treatmentGroups.set(testId, []);
    }
    this.treatmentGroups.get(testId)!.push(metrics);
  }

  /**
   * Calculate performance impact of A/B test
   */
  calculateImpact(testId: string): ABTestPerformanceImpact | null {
    const control = this.controlGroups.get(testId);
    const treatment = this.treatmentGroups.get(testId);

    if (!control || !treatment || control.length === 0 || treatment.length === 0) {
      return null;
    }

    const controlStats = this.calculateGroupStats(control);
    const treatmentStats = this.calculateGroupStats(treatment);

    const lcpImpact = ((treatmentStats.lcp - controlStats.lcp) / controlStats.lcp) * 100;
    const fcpImpact = ((treatmentStats.fcp - controlStats.fcp) / controlStats.fcp) * 100;
    const clsImpact = ((treatmentStats.cls - controlStats.cls) / controlStats.cls) * 100;
    const heapImpact =
      ((treatmentStats.jsHeapSize - controlStats.jsHeapSize) / controlStats.jsHeapSize) *
      100;

    const averageImpact = (lcpImpact + fcpImpact + clsImpact + heapImpact) / 4;

    const confidence = this.calculateConfidence(control, treatment);
    const significant = this.isStatisticallySignificant(control, treatment);

    return {
      testId,
      variant: 'treatment',
      metrics: {
        fcp: treatmentStats.fcp,
        lcp: treatmentStats.lcp,
        cls: treatmentStats.cls,
        jsHeapSize: treatmentStats.jsHeapSize,
      },
      sampleSize: Math.min(control.length, treatment.length),
      confidence,
      impactPercent: averageImpact,
      statisticallySignificant: significant,
      timestamp: new Date(),
    };
  }

  /**
   * Calculate group statistics
   */
  private calculateGroupStats(
    group: PagePerformanceData[]
  ): {
    fcp: number;
    lcp: number;
    cls: number;
    jsHeapSize: number;
  } {
    const fcpValues = group.map(g => g.metrics.fcp);
    const lcpValues = group.map(g => g.metrics.lcp);
    const clsValues = group.map(g => g.metrics.cls);
    const heapValues = group.map(g => g.metrics.jsHeapSize);

    return {
      fcp: this.calculateAverage(fcpValues),
      lcp: this.calculateAverage(lcpValues),
      cls: this.calculateAverage(clsValues),
      jsHeapSize: this.calculateAverage(heapValues),
    };
  }

  /**
   * Calculate average value
   */
  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate standard deviation
   */
  private calculateStandardDeviation(values: number[]): number {
    if (values.length === 0) return 0;

    const avg = this.calculateAverage(values);
    const variance = values.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate confidence level (0-1)
   */
  private calculateConfidence(control: PagePerformanceData[], treatment: PagePerformanceData[]): number {
    const controlLCP = control.map(c => c.metrics.lcp);
    const treatmentLCP = treatment.map(t => t.metrics.lcp);

    const controlStd = this.calculateStandardDeviation(controlLCP);
    const treatmentStd = this.calculateStandardDeviation(treatmentLCP);
    const controlAvg = this.calculateAverage(controlLCP);
    const treatmentAvg = this.calculateAverage(treatmentLCP);

    // Simple t-test approximation
    const pooledStd = Math.sqrt(
      ((control.length - 1) * Math.pow(controlStd, 2) +
        (treatment.length - 1) * Math.pow(treatmentStd, 2)) /
        (control.length + treatment.length - 2)
    );

    const tScore = Math.abs(
      (controlAvg - treatmentAvg) /
        (pooledStd * Math.sqrt(1 / control.length + 1 / treatment.length))
    );

    // Convert t-score to approximate p-value (0-1, where 1 is most significant)
    const pValue = 1 - this.tScoreToPValue(tScore);
    return Math.min(1, Math.max(0, pValue));
  }

  /**
   * Convert t-score to p-value approximation
   */
  private tScoreToPValue(tScore: number): number {
    // Very rough approximation
    if (tScore < 1) return 0.68;
    if (tScore < 1.96) return 0.05;
    if (tScore < 2.58) return 0.01;
    return 0.001;
  }

  /**
   * Check if results are statistically significant (p < 0.05)
   */
  private isStatisticallySignificant(
    control: PagePerformanceData[],
    treatment: PagePerformanceData[]
  ): boolean {
    const confidence = this.calculateConfidence(control, treatment);
    return confidence > 0.95; // p < 0.05
  }

  /**
   * Get test results summary
   */
  getTestResults(testId: string): {
    control: ABTestPerformanceImpact | null;
    treatment: ABTestPerformanceImpact | null;
    winner: 'control' | 'treatment' | 'tie';
    recommendation: string;
  } | null {
    const control = this.controlGroups.get(testId);
    const treatment = this.treatmentGroups.get(testId);

    if (!control || !treatment) {
      return null;
    }

    const impact = this.calculateImpact(testId);
    if (!impact) return null;

    let winner: 'control' | 'treatment' | 'tie' = 'tie';
    let recommendation = 'More data needed for conclusive results';

    if (impact.statisticallySignificant) {
      if (impact.impactPercent < -2) {
        winner = 'treatment';
        recommendation = `Treatment is ${Math.abs(impact.impactPercent).toFixed(1)}% faster. Recommend rollout.`;
      } else if (impact.impactPercent > 2) {
        winner = 'control';
        recommendation = `Control is ${impact.impactPercent.toFixed(1)}% faster. Do not roll out treatment.`;
      }
    }

    return {
      control: null, // Could populate with control variant data
      treatment: impact,
      winner,
      recommendation,
    };
  }

  /**
   * Clear test data
   */
  clearTest(testId: string): void {
    this.controlGroups.delete(testId);
    this.treatmentGroups.delete(testId);
  }

  /**
   * Get all active tests
   */
  getActiveTests(): string[] {
    return Array.from(
      new Set([...this.controlGroups.keys(), ...this.treatmentGroups.keys()])
    );
  }

  /**
   * Get sample sizes
   */
  getSampleSizes(testId: string): { control: number; treatment: number } {
    return {
      control: this.controlGroups.get(testId)?.length || 0,
      treatment: this.treatmentGroups.get(testId)?.length || 0,
    };
  }
}
