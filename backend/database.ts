/**
 * @file database.ts
 * @description Database schema and replication orchestration
 */

import { Pool } from 'pg';
import {
  ReplicationService,
  FailoverService,
  ReadLoadBalancer,
  ConflictResolver,
  ReplicationMonitor,
  type ReplicaConfig,
  type ReadLoadBalanceStrategy,
  type ConflictResolutionPolicy,
} from './database/replication';
import { logger } from './logger';

let primaryPool: Pool | null = null;
let replicationService: ReplicationService | null = null;
let failoverService: FailoverService | null = null;
let readLoadBalancer: ReadLoadBalancer | null = null;
let conflictResolver: ConflictResolver | null = null;
let replicationMonitor: ReplicationMonitor | null = null;

/**
 * Initialize database with replication support
 */
export async function initializeDatabase(
  replicas?: Map<string, ReplicaConfig>,
  readStrategy?: ReadLoadBalanceStrategy,
  conflictPolicy?: ConflictResolutionPolicy
): Promise<void> {
  try {
    // Create primary pool
    primaryPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
    });

    logger.info('Database initialized');

    // Initialize replication if replicas are provided
    if (replicas && replicas.size > 0) {
      replicationService = new ReplicationService(primaryPool);
      await replicationService.initializeReplication(replicas);

      // Initialize failover service
      failoverService = new FailoverService(
        'primary',
        primaryPool,
        replicationService['replicaPools'],
        replicationService['replicationStates']
      );

      // Initialize read load balancer
      readLoadBalancer = new ReadLoadBalancer(
        primaryPool,
        replicationService['replicaPools'],
        replicationService['replicationStates'],
        readStrategy || { type: 'least-lag', maxLagMs: 5000 }
      );

      // Initialize conflict resolver
      conflictResolver = new ConflictResolver(
        conflictPolicy || { strategy: 'last-write-wins' }
      );

      // Initialize replication monitor and start hourly verification
      replicationMonitor = new ReplicationMonitor(primaryPool);
      replicationMonitor.startHourlyVerification();

      logger.info('Replication system initialized successfully');
    }
  } catch (error) {
    logger.error('Failed to initialize database', { error });
    throw error;
  }
}

/**
 * Get primary database pool
 */
export function getPrimaryPool(): Pool {
  if (!primaryPool) {
    throw new Error('Database not initialized');
  }
  return primaryPool;
}

/**
 * Get replication service
 */
export function getReplicationService(): ReplicationService | null {
  return replicationService;
}

/**
 * Get failover service
 */
export function getFailoverService(): FailoverService | null {
  return failoverService;
}

/**
 * Get read load balancer
 */
export function getReadLoadBalancer(): ReadLoadBalancer | null {
  return readLoadBalancer;
}

/**
 * Get conflict resolver
 */
export function getConflictResolver(): ConflictResolver | null {
  return conflictResolver;
}

/**
 * Get replication monitor
 */
export function getReplicationMonitor(): ReplicationMonitor | null {
  return replicationMonitor;
}

/**
 * Execute read query with load balancing
 */
export async function executeReadQuery<T>(
  query: string,
  params?: unknown[]
): Promise<T[]> {
  if (!readLoadBalancer) {
    // No replication configured, use primary
    const result = await primaryPool!.query(query, params);
    return result.rows as T[];
  }

  return readLoadBalancer.executeReadQuery<T>(query, params);
}

/**
 * Execute write query on primary
 */
export async function executeWriteQuery<T>(
  query: string,
  params?: unknown[]
): Promise<T[]> {
  if (!primaryPool) {
    throw new Error('Database not initialized');
  }
  const result = await primaryPool.query(query, params);
  return result.rows as T[];
}

/**
 * Cleanup database resources
 */
export async function cleanupDatabase(): Promise<void> {
  try {
    if (replicationMonitor) {
      replicationMonitor.stopVerification();
    }
    if (replicationService) {
      await replicationService.cleanup();
    }
    if (primaryPool) {
      await primaryPool.end();
    }
    logger.info('Database resources cleaned up');
  } catch (error) {
    logger.error('Error during database cleanup', { error });
  }
}
