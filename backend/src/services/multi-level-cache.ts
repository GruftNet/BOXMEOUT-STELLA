import * as cacheService from './cache.service';
import { memGet, memSet, memDel, memDeletePattern, memClear, memSize } from './memory-cache';
import { recordCacheHit, recordCacheMiss, setL1CacheSize } from './metrics.service';

// L1 entries are capped short so a value never outlives its own L2 TTL by much,
// and so cross-request staleness stays inside the "5s-1h fresh" budget per data type.
const L1_MAX_TTL_SECONDS = 5;

function namespaceOf(key: string): string {
  return key.split(':')[0];
}

export async function get<T>(key: string): Promise<T | null> {
  const namespace = namespaceOf(key);

  const l1Value = memGet<T>(key);
  if (l1Value !== null) {
    recordCacheHit(namespace, 'l1');
    return l1Value;
  }

  const l2Value = await cacheService.get<T>(key);
  if (l2Value !== null) {
    memSet(key, l2Value, L1_MAX_TTL_SECONDS);
    setL1CacheSize(memSize());
    return l2Value;
  }

  recordCacheMiss(namespace);
  return null;
}

export async function set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  memSet(key, value, Math.min(ttlSeconds, L1_MAX_TTL_SECONDS));
  setL1CacheSize(memSize());
  await cacheService.set(key, value, ttlSeconds);
}

export async function invalidate(key: string): Promise<void> {
  memDel(key);
  setL1CacheSize(memSize());
  await cacheService.del(key);
}

export async function invalidatePattern(pattern: string): Promise<void> {
  memDeletePattern(pattern);
  setL1CacheSize(memSize());
  await cacheService.delPattern(pattern);
}

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const cached = await get<T>(key);
  if (cached !== null) {
    return cached;
  }
  const value = await compute();
  await set(key, value, ttlSeconds);
  return value;
}

export async function flushAll(): Promise<void> {
  memClear();
  setL1CacheSize(0);
  await cacheService.flushAll();
}
