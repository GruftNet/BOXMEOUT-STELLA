import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { recordCacheHit, recordCacheMiss, recordCacheError } from './metrics.service';

const SCAN_COUNT = 100;

function namespaceOf(keyOrPattern: string): string {
  return keyOrPattern.split(':')[0];
}

export async function get<T>(key: string): Promise<T | null> {
  const namespace = namespaceOf(key);
  try {
    const raw = await redis.get(key);
    if (raw === null || raw === undefined) {
      recordCacheMiss(namespace);
      return null;
    }
    recordCacheHit(namespace, 'l2');
    return JSON.parse(raw) as T;
  } catch (err) {
    recordCacheError(namespace, 'get');
    logger.warn({ err, key }, 'cache get failed');
    return null;
  }
}

export async function set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const namespace = namespaceOf(key);
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    recordCacheError(namespace, 'set');
    logger.warn({ err, key }, 'cache set failed');
  }
}

export async function del(key: string): Promise<void> {
  const namespace = namespaceOf(key);
  try {
    await redis.del(key);
  } catch (err) {
    recordCacheError(namespace, 'del');
    logger.warn({ err, key }, 'cache del failed');
  }
}

export async function delPattern(pattern: string): Promise<void> {
  const namespace = namespaceOf(pattern);
  try {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    recordCacheError(namespace, 'delPattern');
    logger.warn({ err, pattern }, 'cache delPattern failed');
  }
}

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const namespace = namespaceOf(key);
  let cached: T | null = null;
  let getSucceeded = true;

  try {
    const raw = await redis.get(key);
    cached = raw ? (JSON.parse(raw) as T) : null;
    if (cached !== null) {
      recordCacheHit(namespace, 'l2');
    } else {
      recordCacheMiss(namespace);
    }
  } catch (err) {
    getSucceeded = false;
    recordCacheError(namespace, 'getOrSet');
    logger.warn({ err, key }, 'cache getOrSet get failed');
  }

  if (cached !== null) {
    return cached;
  }

  const value = await compute();

  if (getSucceeded) {
    await set(key, value, ttlSeconds);
  }

  return value;
}

export async function flushAll(): Promise<void> {
  try {
    await redis.flushdb();
    logger.info('cache flushAll: redis flushed');
  } catch (err) {
    recordCacheError('all', 'flushAll');
    logger.warn({ err }, 'cache flushAll failed');
  }
}

// Legacy aliases retained for callers written against the earlier cache API.
export const cacheGet = get;
export const cacheSet = set;
export const cacheDelete = del;
export const cacheDeletePattern = delPattern;
