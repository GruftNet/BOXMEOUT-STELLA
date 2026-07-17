/**
 * @file conflictResolver.ts
 * @description Conflict resolution for replicated data
 */

import { ConflictResolutionPolicy } from './types';
import { logger } from '../../logger';

export interface ConflictData {
  primaryValue: unknown;
  replicaValue: unknown;
  primaryTimestamp?: Date;
  replicaTimestamp?: Date;
  rowId: string | number;
  tableName: string;
  columnName: string;
}

export class ConflictResolver {
  private policy: ConflictResolutionPolicy;

  constructor(policy: ConflictResolutionPolicy = { strategy: 'last-write-wins' }) {
    this.policy = policy;
  }

  /**
   * Resolve conflict between primary and replica values
   */
  async resolveConflict(conflict: ConflictData): Promise<unknown> {
    switch (this.policy.strategy) {
      case 'last-write-wins':
        return this.resolveLastWriteWins(conflict);
      case 'primary-wins':
        return this.resolvePrimaryWins(conflict);
      case 'reject':
        return this.rejectConflict(conflict);
      default:
        throw new Error(`Unknown conflict resolution strategy: ${this.policy.strategy}`);
    }
  }

  /**
   * Last-write-wins strategy: use the value with the most recent timestamp
   */
  private resolveLastWriteWins(conflict: ConflictData): unknown {
    if (!conflict.primaryTimestamp || !conflict.replicaTimestamp) {
      logger.warn('Missing timestamps for last-write-wins resolution', {
        table: conflict.tableName,
        column: conflict.columnName,
        rowId: conflict.rowId,
      });
      return conflict.primaryValue;
    }

    const isPrimaryNewer = conflict.primaryTimestamp > conflict.replicaTimestamp;
    const winner = isPrimaryNewer ? conflict.primaryValue : conflict.replicaValue;

    logger.info('Resolved conflict using last-write-wins', {
      table: conflict.tableName,
      column: conflict.columnName,
      rowId: conflict.rowId,
      winner: isPrimaryNewer ? 'primary' : 'replica',
    });

    return winner;
  }

  /**
   * Primary-wins strategy: always prefer primary value
   */
  private resolvePrimaryWins(conflict: ConflictData): unknown {
    logger.info('Resolved conflict using primary-wins', {
      table: conflict.tableName,
      column: conflict.columnName,
      rowId: conflict.rowId,
    });
    return conflict.primaryValue;
  }

  /**
   * Reject strategy: throw error on conflict detection
   */
  private rejectConflict(conflict: ConflictData): never {
    const error = new Error(
      `Conflict detected and rejection policy active: ${conflict.tableName}.${conflict.columnName} row ${conflict.rowId}`
    );
    logger.error('Conflict rejected', {
      table: conflict.tableName,
      column: conflict.columnName,
      rowId: conflict.rowId,
    });
    throw error;
  }

  /**
   * Update conflict resolution policy
   */
  updatePolicy(policy: ConflictResolutionPolicy): void {
    this.policy = policy;
    logger.info('Conflict resolution policy updated', { strategy: policy.strategy });
  }

  /**
   * Get current policy
   */
  getPolicy(): ConflictResolutionPolicy {
    return this.policy;
  }

  /**
   * Check if conflict detection is needed based on TTL
   */
  isConflictRelevant(timestamp: Date): boolean {
    if (!this.policy.ttlMs) {
      return true;
    }

    const age = Date.now() - timestamp.getTime();
    return age <= this.policy.ttlMs;
  }
}
