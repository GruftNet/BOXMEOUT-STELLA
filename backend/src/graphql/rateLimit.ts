import { GraphQLError } from 'graphql';
import { redis } from '../config/redis';

export interface GraphQLRateLimitOptions {
  windowMs?: number;
  max?: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

/**
 * Per-user Redis rate limiter for GraphQL operations.
 * Keyed by userId when present, otherwise by IP / anonymous id.
 */
export async function assertGraphQLRateLimit(
  identity: string,
  options: GraphQLRateLimitOptions = {},
): Promise<void> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX;
  const windowSec = Math.ceil(windowMs / 1000);
  const key = `rl:graphql:${identity}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }

  if (count > max) {
    const ttl = await redis.ttl(key);
    throw new GraphQLError('Too Many Requests', {
      extensions: {
        code: 'RATE_LIMITED',
        retryAfter: ttl > 0 ? ttl : windowSec,
      },
    });
  }
}

/** Test helper — clears rate-limit keys for an identity. */
export async function resetGraphQLRateLimit(identity: string): Promise<void> {
  await redis.del(`rl:graphql:${identity}`);
}
