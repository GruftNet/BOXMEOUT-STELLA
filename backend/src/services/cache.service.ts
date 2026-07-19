// ============================================================
// BOXMEOUT — Centralized Cache Service
// Provides Redis cache operations with automatic invalidation.
// Namespaced keys: market:{id}, leaderboard:global:*, user:{id}:balance
// ============================================================

import { redis } from '../config/redis';
import { logger } from '../utils/logger';

export { redis };

/**
 * Get a value from cache by key.
 * Returns null if key doesn't exist or Redis is unavailable.
 */
export async function get<T>(key: string): Promise<T | null> {
  try {
    const data = await redis.get(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch (err) {
    logger.warn({ err, key }, 'cache.get: Redis unavailable, bypassing cache');
    return null;
  }
}

/**
 * Set a value in cache with TTL in seconds.
 */
export async function set(key: string, value: unknown, ttl_seconds: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl_seconds);
  } catch (err) {
    logger.warn({ err, key }, 'cache.set: Redis unavailable, bypassing cache');
  }
}

/**
 * Delete a single cache key.
 */
export async function del(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, 'cache.del: Redis unavailable, bypassing cache');
  }
}

/**
 * Delete all keys matching a pattern using Redis SCAN.
 * Pattern examples: 'market:*', 'leaderboard:global:*', 'user:*:balance'
 */
export async function delPattern(pattern: string): Promise<void> {
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info({ pattern, count: keys.length }, 'cache.delPattern: Invalidated keys');
    }
  } catch (err) {
    logger.warn({ err, pattern }, 'cache.delPattern: Redis unavailable, bypassing cache');
  }
}

/**
 * Get a value from cache, or compute and cache it if missing.
 * @param key - Cache key
 * @param ttl_seconds - TTL for cached value
 * @param compute - Function to compute value if cache miss
 */
export async function getOrSet<T>(
  key: string,
  ttl_seconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    // Try to get from cache first
    const cached = await get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Cache miss - compute value
    const value = await compute();
    
    // Store in cache
    await set(key, value, ttl_seconds);
    
    return value;
  } catch (err) {
    logger.warn({ err, key }, 'cache.getOrSet: Error, computing without cache');
    // If cache operations fail, just compute and return
    return compute();
  }
}

// ============================================================
// Legacy aliases for backward compatibility
// ============================================================

export const cacheGet = get;
export const cacheSet = set;
export const cacheDelete = del;
export const cacheDeletePattern = delPattern;
