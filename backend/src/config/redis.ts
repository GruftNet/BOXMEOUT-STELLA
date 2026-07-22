import Redis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(attempt: number) {
    return Math.min(attempt * 200, 2000);
  },
  reconnectOnError(err: Error) {
    return err.message.includes('READONLY');
  },
});

redis.on('error', (err) => {
  logger.warn({ err }, 'redis connection error');
});

redis.on('connect', () => {
  logger.info('redis connected');
});
