/**
 * @file replicationService.ts
 * @description PostgreSQL streaming replication manager
 */

import { Pool } from 'pg';
import { ReplicaConfig, ReplicationState, ReplicationMetrics, ReplicationHealth } from './types';
import { logger } from '../../logger';

export class ReplicationService {
  private primaryPool: Pool;
  private replicaPools: Map<string, Pool> = new Map();
  private replicationStates: Map<string, ReplicationState> = new Map();
  private metricsHistory: ReplicationMetrics[] = [];
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly MAX_METRICS_HISTORY = 1000;
  private readonly HEALTH_CHECK_INTERVAL_MS = 5000;
  private readonly REPLICATION_SLOT_PREFIX = 'slot_replica_';

  constructor(primaryPool: Pool) {
    this.primaryPool = primaryPool;
  }

  /**
   * Initialize streaming replication with multiple replicas
   */
  async initializeReplication(replicas: Map<string, ReplicaConfig>): Promise<void> {
    logger.info(`Initializing replication for ${replicas.size} replica(s)`);

    try {
      // Create replication slots on primary
      for (const [replicaId] of replicas) {
        await this.createReplicationSlot(replicaId);
      }

      // Connect to all replicas
      for (const [replicaId, config] of replicas) {
        const pool = new Pool({
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password,
          ssl: config.sslMode === 'require' ? true : false,
          max: 10,
          idleTimeoutMillis: 30000,
        });

        this.replicaPools.set(replicaId, pool);
        
        // Initialize state tracking
        const state: ReplicationState = {
          replicaId,
          isHealthy: false,
          lagBytes: 0,
          lagSeconds: 0,
          lastHeartbeat: new Date(),
          flushLsn: '0/0',
          replayLsn: '0/0',
          slotName: `${this.REPLICATION_SLOT_PREFIX}${replicaId}`,
        };
        this.replicationStates.set(replicaId, state);
      }

      // Start periodic health checks
      this.startHealthChecks();
      logger.info('Replication initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize replication', { error });
      throw error;
    }
  }

  /**
   * Create replication slot on primary
   */
  private async createReplicationSlot(replicaId: string): Promise<void> {
    const slotName = `${this.REPLICATION_SLOT_PREFIX}${replicaId}`;
    
    try {
      await this.primaryPool.query(
        `SELECT * FROM pg_create_logical_replication_slot($1, 'pgoutput')`,
        [slotName]
      );
      logger.info(`Created replication slot: ${slotName}`);
    } catch (error: any) {
      if (error.code === 'DUPLICATE_OBJECT') {
        logger.info(`Replication slot already exists: ${slotName}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Monitor replication lag for all replicas
   */
  async monitorReplicationLag(): Promise<Map<string, ReplicationMetrics>> {
    const metrics = new Map<string, ReplicationMetrics>();

    for (const [replicaId, state] of this.replicationStates) {
      try {
        const lag = await this.queryReplicationLag(replicaId);
        state.lagBytes = lag.lagBytes;
        state.lagSeconds = lag.lagSeconds;
        state.flushLsn = lag.flushLsn;
        state.replayLsn = lag.replayLsn;
        state.lastHeartbeat = new Date();
        state.isHealthy = lag.lagSeconds < 5; // Healthy if lag < 5s

        const metric: ReplicationMetrics = {
          replicaId,
          timestamp: new Date(),
          lagBytes: lag.lagBytes,
          lagSeconds: lag.lagSeconds,
          networkLatencyMs: 0, // Can be calculated from heartbeat timing
          bytesReceived: 0,
          bytesReplayed: 0,
          transactionsApplied: 0,
        };
        
        metrics.set(replicaId, metric);
        this.addMetric(metric);
      } catch (error) {
        logger.warn(`Failed to query replication lag for ${replicaId}`, { error });
        state.isHealthy = false;
      }
    }

    return metrics;
  }

  /**
   * Query replication lag from a replica
   */
  private async queryReplicationLag(
    replicaId: string
  ): Promise<{ lagBytes: number; lagSeconds: number; flushLsn: string; replayLsn: string }> {
    const pool = this.replicaPools.get(replicaId);
    if (!pool) {
      throw new Error(`Replica pool not found for ${replicaId}`);
    }

    const result = await pool.query(`
      SELECT 
        EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))::int as lag_seconds,
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint as lag_bytes,
        pg_walfile_name(flush_lsn) as flush_lsn,
        pg_walfile_name(replay_lsn) as replay_lsn
      FROM pg_stat_replication
      WHERE client_addr = $1
      LIMIT 1
    `, ['127.0.0.1']); // Adjust IP as needed

    const row = result.rows[0] || {
      lag_seconds: 0,
      lag_bytes: 0,
      flush_lsn: '0/0',
      replay_lsn: '0/0',
    };

    return {
      lagSeconds: parseInt(row.lag_seconds) || 0,
      lagBytes: parseInt(row.lag_bytes) || 0,
      flushLsn: row.flush_lsn,
      replayLsn: row.replay_lsn,
    };
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.monitorReplicationLag();
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Get current replication health status
   */
  async getReplicationHealth(): Promise<ReplicationHealth> {
    const now = new Date();
    const states = Array.from(this.replicationStates.values());
    const healthyCount = states.filter(s => s.isHealthy).length;
    
    // Calculate p95 lag
    const lagValues = states.map(s => s.lagSeconds * 1000).sort((a, b) => a - b);
    const p95Index = Math.floor(lagValues.length * 0.95);
    const lagPercentile95Ms = lagValues[p95Index] || 0;

    return {
      status: healthyCount === states.length ? 'healthy' : 
              healthyCount > 0 ? 'degraded' : 'failed',
      primaryAvailable: true, // Check with heartbeat
      replicasHealthy: healthyCount,
      replicasTotal: states.length,
      lagPercentile95Ms,
      lastCheckTime: now,
    };
  }

  /**
   * Get replica by ID
   */
  getReplicaState(replicaId: string): ReplicationState | undefined {
    return this.replicationStates.get(replicaId);
  }

  /**
   * Get all replicas health status
   */
  getAllReplicaStates(): ReplicationState[] {
    return Array.from(this.replicationStates.values());
  }

  /**
   * Add metric to history (with size limit)
   */
  private addMetric(metric: ReplicationMetrics): void {
    this.metricsHistory.push(metric);
    if (this.metricsHistory.length > this.MAX_METRICS_HISTORY) {
      this.metricsHistory.shift();
    }
  }

  /**
   * Get metrics history for a replica
   */
  getMetricsHistory(replicaId: string, limitMs: number = 3600000): ReplicationMetrics[] {
    const cutoff = Date.now() - limitMs;
    return this.metricsHistory.filter(
      m => m.replicaId === replicaId && m.timestamp.getTime() > cutoff
    );
  }

  /**
   * Clean up replication resources
   */
  async cleanup(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    for (const pool of this.replicaPools.values()) {
      await pool.end();
    }
    this.replicaPools.clear();
    logger.info('Replication service cleaned up');
  }
}
