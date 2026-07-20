// ============================================================
// BOXMEOUT — Shard Router
// Key-directed and scatter-gather query routing
// ============================================================

import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { loadShardMap, resolveShard, validateShardMap, type ShardDescriptor } from './shardMap';

export interface ShardHealth {
  shardKey: string;
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Routing surface used by services.
 *
 * Services depend on this interface, never on a Pool directly. That is the
 * whole point of introducing it now while BOXMEOUT still runs on one database:
 * adding a second shard later becomes a deployment change instead of a rewrite
 * of every query site.
 */
export interface ShardRouter {
  /** Run a query on the shard owning `shardKey` (a market_id). */
  query<T extends QueryResultRow = QueryResultRow>(
    shardKey: string,
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;

  /**
   * Run a query on every active shard and concatenate the rows.
   *
   * Ordering across shards is not meaningful — callers that need a global sort
   * or LIMIT must re-sort the merged rows themselves. Avoid on hot paths;
   * latency is that of the slowest shard.
   */
  queryAll<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;

  healthCheck(): Promise<ShardHealth[]>;

  close(): Promise<void>;
}

/**
 * The deployed router: one Pool per registry entry.
 *
 * With the default single-row shard_map this degenerates to a plain connection
 * pool, so it is safe to route everything through it from day one.
 */
export class PoolShardRouter implements ShardRouter {
  private readonly pools = new Map<string, Pool>();

  private constructor(private readonly shards: ShardDescriptor[]) {}

  static async create(controlPool: Pool): Promise<PoolShardRouter> {
    const shards = await loadShardMap(controlPool);
    validateShardMap(shards);

    const router = new PoolShardRouter(shards);
    for (const shard of shards) {
      const dsn = process.env[shard.dsnEnvVar];
      if (!dsn) {
        throw new Error(`shard '${shard.shardKey}' expects connection string in ${shard.dsnEnvVar}, which is unset`);
      }
      router.pools.set(shard.shardKey, new Pool({ connectionString: dsn }));
    }
    return router;
  }

  private poolFor(shard: ShardDescriptor): Pool {
    const pool = this.pools.get(shard.shardKey);
    if (!pool) {
      throw new Error(`no pool initialised for shard '${shard.shardKey}'`);
    }
    return pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    shardKey: string,
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const shard = resolveShard(this.shards, shardKey);

    // Draining shards still serve reads and writes — a drain moves slots, it
    // does not stop traffic. Only an offline shard is refused.
    if (shard.status === 'offline') {
      throw new Error(`shard '${shard.shardKey}' is offline`);
    }

    return this.poolFor(shard).query<T>(text, values);
  }

  async queryAll<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const active = this.shards.filter((s) => s.status !== 'offline');

    // Fail the whole fan-out if any shard errors. A partial result set is
    // worse than an error here: callers aggregate these rows into totals and
    // would silently report low numbers.
    const results = await Promise.all(active.map((shard) => this.poolFor(shard).query<T>(text, values)));

    return results.flatMap((r) => r.rows);
  }

  async healthCheck(): Promise<ShardHealth[]> {
    return Promise.all(
      this.shards.map(async (shard) => {
        const startedAt = Date.now();
        try {
          await this.poolFor(shard).query('SELECT 1');
          return {
            shardKey: shard.shardKey,
            healthy: true,
            latencyMs: Date.now() - startedAt,
            error: null,
          };
        } catch (err) {
          return {
            shardKey: shard.shardKey,
            healthy: false,
            latencyMs: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}

/** Persist the outcome of a health sweep so operators and alerting can read it. */
export async function recordHealthResults(controlPool: Pool, results: ShardHealth[]): Promise<void> {
  for (const result of results) {
    await controlPool.query(
      `UPDATE shard_map
          SET healthy = $2, last_health_check_at = NOW()
        WHERE shard_key = $1`,
      [result.shardKey, result.healthy],
    );
  }
}
