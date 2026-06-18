import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, { lazyConnect: true });

/** Dedicated subscriber client — must be separate from `redis` for pub/sub. */
export const redisSub = new Redis(REDIS_URL, { lazyConnect: true });

export const MARKET_EVENTS_PATTERN = 'market:*:events';

export function marketEventChannel(marketId: string): string {
  return `market:${marketId}:events`;
}

export function parseMarketIdFromChannel(channel: string): string | null {
  const match = /^market:(.+):events$/.exec(channel);
  return match ? match[1] : null;
}

export async function connectRedisClients(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
  if (redisSub.status === 'wait') {
    await redisSub.connect();
  }
}

export async function closeRedisClients(): Promise<void> {
  await Promise.allSettled([
    redis.status !== 'end' ? redis.quit() : undefined,
    redisSub.status !== 'end' ? redisSub.quit() : undefined,
  ]);
}

export function disconnectRedisClients(): void {
  if (redis.status !== 'end') {
    redis.disconnect();
  }
  if (redisSub.status !== 'end') {
    redisSub.disconnect();
  }
}
