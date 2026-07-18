/**
 * @file cache.service.ts
 * @description Redis cache service — provides a shared ioredis client instance.
 *
 * The module exports a `redis` object so other modules can import and call
 * ioredis commands directly (e.g. `redis.incr(key)`).
 */
import Redis from 'ioredis';

const redisUrl =
  process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('error', (err: Error) => {
  // Log but don't crash — middleware handles fallback gracefully
  console.error('[cache.service] Redis error:', err.message);
});
