/**
 * @file types.ts
 * @description Replication system type definitions
 */

export interface ReplicaConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode?: 'disable' | 'require' | 'prefer';
}

export interface ReplicationState {
  replicaId: string;
  isHealthy: boolean;
  lagBytes: number;
  lagSeconds: number;
  lastHeartbeat: Date;
  flushLsn: string;
  replayLsn: string;
  slotName: string;
}

export interface FailoverContext {
  failedPrimaryId: string;
  selectedReplicaId: string;
  failoverTime: Date;
  rtoMs: number;
  dataLossBytes?: number;
}

export interface ConflictResolutionPolicy {
  strategy: 'last-write-wins' | 'primary-wins' | 'reject';
  timestampField?: string;
  ttlMs?: number;
}

export interface ReplicationMetrics {
  replicaId: string;
  timestamp: Date;
  lagBytes: number;
  lagSeconds: number;
  networkLatencyMs: number;
  bytesReceived: number;
  bytesReplayed: number;
  transactionsApplied: number;
}

export interface ReadLoadBalanceStrategy {
  type: 'round-robin' | 'least-lag' | 'random' | 'geo-affinity';
  maxLagMs?: number;
  healthCheckIntervalMs?: number;
}

export interface ReplicationHealth {
  status: 'healthy' | 'degraded' | 'failed';
  primaryAvailable: boolean;
  replicasHealthy: number;
  replicasTotal: number;
  lagPercentile95Ms: number;
  lastCheckTime: Date;
}
