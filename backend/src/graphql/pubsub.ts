import { EventEmitter } from 'events';
import {
  connectRedisClients,
  MARKET_EVENTS_PATTERN,
  marketEventChannel,
  parseMarketIdFromChannel,
  redis,
  redisSub,
} from '../config/redis';
import type { ActivityEvent } from '../websocket/realtime';
import { logger } from '../utils/logger';

export const GRAPHQL_MARKET_UPDATED = 'GRAPHQL_MARKET_UPDATED';
export const GRAPHQL_TRADE_CREATED = 'GRAPHQL_TRADE_CREATED';

type Listener = (payload: unknown) => void;

/**
 * Hybrid pub/sub: in-process EventEmitter for same-instance delivery,
 * Redis fan-out for cluster-wide GraphQL subscriptions.
 */
class GraphQLPubSub {
  private ee = new EventEmitter();
  private redisReady = false;
  private redisHandlerAttached = false;

  constructor() {
    this.ee.setMaxListeners(100);
  }

  async init(): Promise<void> {
    if (this.redisReady) return;
    await connectRedisClients();

    if (!this.redisHandlerAttached) {
      redisSub.on('pmessage', this.onRedisMessage);
      this.redisHandlerAttached = true;
    }

    await redisSub.psubscribe(MARKET_EVENTS_PATTERN);
    this.redisReady = true;
    logger.info('GraphQL pub/sub listening on market:*:events');
  }

  private onRedisMessage = (_pattern: string, channel: string, message: string): void => {
    const marketId = parseMarketIdFromChannel(channel);
    if (!marketId) return;

    let event: ActivityEvent;
    try {
      event = JSON.parse(message) as ActivityEvent;
    } catch {
      return;
    }

    this.ee.emit(`activity:${marketId}`, event);

    if (event.type === 'trade') {
      this.ee.emit(`${GRAPHQL_TRADE_CREATED}:${marketId}`, event);
    }

    if (event.type === 'resolved' || event.type === 'dispute' || event.type === 'trade') {
      this.ee.emit(`${GRAPHQL_MARKET_UPDATED}:${marketId}`, event);
    }
  };

  /** Fan out locally (same process) then via Redis for other instances. */
  emitLocal(marketId: string, event: ActivityEvent): void {
    this.ee.emit(`activity:${marketId}`, event);
    if (event.type === 'trade') {
      this.ee.emit(`${GRAPHQL_TRADE_CREATED}:${marketId}`, event);
    }
    if (event.type === 'resolved' || event.type === 'dispute' || event.type === 'trade') {
      this.ee.emit(`${GRAPHQL_MARKET_UPDATED}:${marketId}`, event);
    }
  }

  /**
   * Publish an activity event for GraphQL subscribers.
   * Prefer Redis (cluster fan-out; publisher also receives via pmessage).
   * Fall back to in-process emit when Redis is unavailable.
   */
  async publishActivity(marketId: string, event: ActivityEvent): Promise<void> {
    try {
      await connectRedisClients();
      await redis.publish(marketEventChannel(marketId), JSON.stringify(event));
    } catch (err) {
      logger.warn({ err, marketId }, 'GraphQL pub/sub Redis publish failed; using local emit');
      this.emitLocal(marketId, event);
    }
  }

  asyncIterator<T>(eventName: string): AsyncIterableIterator<T> {
    const ee = this.ee;
    const queue: T[] = [];
    let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
    let done = false;

    const onEvent: Listener = (payload) => {
      const value = payload as T;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value, done: false });
      } else {
        queue.push(value);
      }
    };

    ee.on(eventName, onEvent);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<T>> {
        if (done) return Promise.resolve({ value: undefined as T, done: true });
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift() as T, done: false });
        }
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return(): Promise<IteratorResult<T>> {
        done = true;
        ee.off(eventName, onEvent);
        if (resolveNext) {
          resolveNext({ value: undefined as T, done: true });
          resolveNext = null;
        }
        return Promise.resolve({ value: undefined as T, done: true });
      },
      throw(err: unknown): Promise<IteratorResult<T>> {
        done = true;
        ee.off(eventName, onEvent);
        return Promise.reject(err);
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.redisHandlerAttached) {
      redisSub.off('pmessage', this.onRedisMessage);
      this.redisHandlerAttached = false;
    }
    this.redisReady = false;
    this.ee.removeAllListeners();
  }
}

export const graphqlPubSub = new GraphQLPubSub();
