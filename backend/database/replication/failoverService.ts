/**
 * @file failoverService.ts
 * @description Automatic failover management with <30s RTO
 */

import { Pool } from 'pg';
import { FailoverContext, ReplicationState } from './types';
import { logger } from '../../logger';

export class FailoverService {
  private currentPrimaryId: string;
  private primaryPool: Pool;
  private replicaPools: Map<string, Pool>;
  private replicationStates: Map<string, ReplicationState>;
  private failoverInProgress = false;
  private lastFailoverTime: Date | null = null;
  private readonly FAILOVER_TIMEOUT_MS = 30000; // 30 second RTO target
  private readonly PROMOTION_TIMEOUT_MS = 20000; // 20 seconds for promotion

  constructor(
    primaryId: string,
    primaryPool: Pool,
    replicaPools: Map<string, Pool>,
    replicationStates: Map<string, ReplicationState>
  ) {
    this.currentPrimaryId = primaryId;
    this.primaryPool = primaryPool;
    this.replicaPools = replicaPools;
    this.replicationStates = replicationStates;
  }

  /**
   * Detect primary failure
   */
  async detectPrimaryFailure(): Promise<boolean> {
    try {
      const result = await this.primaryPool.query('SELECT 1');
      return !result;
    } catch (error) {
      logger.warn('Primary failure detected', { error });
      return true;
    }
  }

  /**
   * Execute failover to best available replica
   */
  async executeFailover(): Promise<FailoverContext> {
    if (this.failoverInProgress) {
      throw new Error('Failover already in progress');
    }

    this.failoverInProgress = true;
    const startTime = Date.now();

    try {
      logger.info('Starting failover process');

      // Select best replica (lowest lag)
      const selectedReplica = this.selectBestReplica();
      if (!selectedReplica) {
        throw new Error('No healthy replica available for failover');
      }

      logger.info(`Selected replica for promotion: ${selectedReplica.replicaId}`, {
        lag: selectedReplica.lagSeconds,
      });

      // Promote replica to primary
      const replicaPool = this.replicaPools.get(selectedReplica.replicaId);
      if (!replicaPool) {
        throw new Error(`Replica pool not found: ${selectedReplica.replicaId}`);
      }

      await this.promoteReplicaToPrimary(replicaPool, selectedReplica.replicaId);

      const rtoMs = Date.now() - startTime;
      logger.info(`Failover completed in ${rtoMs}ms`);

      if (rtoMs > this.FAILOVER_TIMEOUT_MS) {
        logger.warn(`Failover exceeded RTO target: ${rtoMs}ms > ${this.FAILOVER_TIMEOUT_MS}ms`);
      }

      this.lastFailoverTime = new Date();
      this.currentPrimaryId = selectedReplica.replicaId;

      return {
        failedPrimaryId: this.currentPrimaryId,
        selectedReplicaId: selectedReplica.replicaId,
        failoverTime: new Date(),
        rtoMs,
        dataLossBytes: selectedReplica.lagBytes,
      };
    } finally {
      this.failoverInProgress = false;
    }
  }

  /**
   * Select best replica based on replication lag
   */
  private selectBestReplica(): ReplicationState | null {
    const healthyReplicas = Array.from(this.replicationStates.values()).filter(
      s => s.isHealthy && s.replicaId !== this.currentPrimaryId
    );

    if (healthyReplicas.length === 0) {
      return null;
    }

    // Sort by lag (ascending) and return the one with smallest lag
    return healthyReplicas.sort((a, b) => a.lagBytes - b.lagBytes)[0];
  }

  /**
   * Promote replica to primary
   */
  private async promoteReplicaToPrimary(replicaPool: Pool, replicaId: string): Promise<void> {
    try {
      // Create a connection with custom timeout
      const client = await Promise.race([
        replicaPool.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Promotion timeout')), this.PROMOTION_TIMEOUT_MS)
        ),
      ]) as any;

      try {
        // Promote standby to primary
        await client.query('SELECT pg_promote()');
        logger.info(`Promoted replica ${replicaId} to primary`);

        // Wait for promotion to complete
        await this.waitForPromotionCompletion(client);
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error(`Failed to promote replica ${replicaId}`, { error });
      throw error;
    }
  }

  /**
   * Wait for promotion to complete
   */
  private async waitForPromotionCompletion(client: any): Promise<void> {
    const maxAttempts = 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const result = await client.query(
          `SELECT pg_is_in_recovery() as in_recovery`
        );
        
        if (!result.rows[0]?.in_recovery) {
          logger.info('Promotion completed successfully');
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      } catch (error) {
        logger.warn('Error checking promotion status', { error });
        attempts++;
      }
    }

    throw new Error('Promotion did not complete within expected time');
  }

  /**
   * Check if failover is in progress
   */
  isFailoverInProgress(): boolean {
    return this.failoverInProgress;
  }

  /**
   * Get last failover time
   */
  getLastFailoverTime(): Date | null {
    return this.lastFailoverTime;
  }

  /**
   * Get current primary ID
   */
  getCurrentPrimaryId(): string {
    return this.currentPrimaryId;
  }

  /**
   * Update primary pool (called after failover)
   */
  updatePrimaryPool(newPrimaryPool: Pool): void {
    this.primaryPool = newPrimaryPool;
  }
}
