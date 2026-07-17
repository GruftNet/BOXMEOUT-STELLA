/**
 * @file readLoadBalancer.ts
 * @description Read replica load balancing with multiple strategies
 */

import { Pool } from 'pg';
import { ReadLoadBalanceStrategy, ReplicationState } from './types';
import { logger } from '../../logger';

export class ReadLoadBalancer {
  private replicaPools: Map<string, Pool>;
  private replicationStates: Map<string, ReplicationState>;
  private strategy: ReadLoadBalanceStrategy;
  private roundRobinIndex = 0;
  private primaryPool: Pool;

  constructor(
    primaryPool: Pool,
    replicaPools: Map<string, Pool>,
    replicationStates: Map<string, ReplicationState>,
    strategy: ReadLoadBalanceStrategy = { type: 'least-lag', maxLagMs: 5000 }
  ) {
    this.primaryPool = primaryPool;
    this.replicaPools = replicaPools;
    this.replicationStates = replicationStates;
    this.strategy = strategy;
  }

  /**
   * Select a replica pool for read query based on configured strategy
   */
  selectReplicaPool(): Pool | null {
    const available = this.getAvailableReplicas();

    if (available.length === 0) {
      logger.debug('No healthy replicas available, using primary');
      return null;
    }

    let selected: ReplicationState | null = null;

    switch (this.strategy.type) {
      case 'round-robin':
        selected = this.selectRoundRobin(available);
        break;
      case 'least-lag':
        selected = this.selectLeastLag(available);
        break;
      case 'random':
        selected = this.selectRandom(available);
        break;
      case 'geo-affinity':
        selected = this.selectGeoAffinity(available);
        break;
      default:
        selected = available[0];
    }

    if (!selected) {
      return null;
    }

    const pool = this.replicaPools.get(selected.replicaId);
    return pool || null;
  }

  /**
   * Get available replicas (healthy and within lag threshold)
   */
  private getAvailableReplicas(): ReplicationState[] {
    const maxLagMs = this.strategy.maxLagMs || 5000;
    const maxLagSeconds = maxLagMs / 1000;

    return Array.from(this.replicationStates.values()).filter(
      s => s.isHealthy && s.lagSeconds <= maxLagSeconds
    );
  }

  /**
   * Round-robin selection
   */
  private selectRoundRobin(available: ReplicationState[]): ReplicationState {
    const selected = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex++;
    return selected;
  }

  /**
   * Select replica with least replication lag
   */
  private selectLeastLag(available: ReplicationState[]): ReplicationState {
    return available.reduce((best, current) =>
      current.lagSeconds < best.lagSeconds ? current : best
    );
  }

  /**
   * Random selection
   */
  private selectRandom(available: ReplicationState[]): ReplicationState {
    return available[Math.floor(Math.random() * available.length)];
  }

  /**
   * Geo-affinity selection (stub for extension)
   */
  private selectGeoAffinity(available: ReplicationState[]): ReplicationState {
    // Can be extended to use geo-location or custom metadata
    return available[0];
  }

  /**
   * Execute read query on appropriate replica or primary
   */
  async executeReadQuery<T>(query: string, params?: unknown[]): Promise<T[]> {
    const pool = this.selectReplicaPool();
    
    try {
      const result = await (pool || this.primaryPool).query(query, params);
      return result.rows as T[];
    } catch (error) {
      logger.error('Read query failed on replica, falling back to primary', { error });
      const result = await this.primaryPool.query(query, params);
      return result.rows as T[];
    }
  }

  /**
   * Get load distribution statistics (80% of reads from replicas target)
   */
  getLoadDistribution(): {
    percentageFromReplicas: number;
    totalReadAttempts: number;
    successfulReplicaReads: number;
  } {
    // This would track actual query statistics
    // Placeholder implementation for demonstration
    return {
      percentageFromReplicas: 0,
      totalReadAttempts: 0,
      successfulReplicaReads: 0,
    };
  }

  /**
   * Update strategy
   */
  updateStrategy(newStrategy: ReadLoadBalanceStrategy): void {
    this.strategy = newStrategy;
    logger.info('Load balancing strategy updated', { strategy: newStrategy.type });
  }

  /**
   * Reset round-robin index
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex = 0;
  }
}
