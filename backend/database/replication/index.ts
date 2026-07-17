/**
 * @file index.ts
 * @description Replication system exports
 */

export { ReplicationService } from './replicationService';
export { FailoverService } from './failoverService';
export { ReadLoadBalancer } from './readLoadBalancer';
export { ConflictResolver } from './conflictResolver';
export { ReplicationMonitor } from './replicationMonitor';

export type {
  ReplicaConfig,
  ReplicationState,
  FailoverContext,
  ConflictResolutionPolicy,
  ReplicationMetrics,
  ReadLoadBalanceStrategy,
  ReplicationHealth,
} from './types';

export type { ConflictData } from './conflictResolver';
export type { ReplicationVerification } from './replicationMonitor';
