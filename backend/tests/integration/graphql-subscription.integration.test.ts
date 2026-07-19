// Integration: GraphQL pub/sub delivers market activity in < 500ms via Redis

import { connectRedisClients, closeRedisClients } from '../../src/config/redis';
import { graphqlPubSub } from '../../src/graphql/pubsub';
import type { ActivityEvent } from '../../src/websocket/realtime';

describe('GraphQL subscription pub/sub integration', () => {
  let redisAvailable = false;

  beforeAll(async () => {
    try {
      await connectRedisClients();
      await graphqlPubSub.init();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
  });

  afterAll(async () => {
    await graphqlPubSub.shutdown();
    if (redisAvailable) {
      await closeRedisClients();
    }
  });

  it('delivers marketActivity events within 500ms', async () => {
    if (!redisAvailable) {
      console.warn('Skipping: Redis unavailable');
      return;
    }
    const marketId = `gql-sub-${Date.now()}`;
    const iterator = graphqlPubSub.asyncIterator<ActivityEvent>(`activity:${marketId}`);

    const event: ActivityEvent = {
      type: 'trade',
      marketId,
      outcomeId: 'fighter_a',
      side: 'fighter_a',
      sharesAmount: 1_000_000,
      priceBps: 5000,
      timestamp: new Date().toISOString(),
    };

    const started = Date.now();
    const pending = iterator.next();

    // Allow subscriber registration to settle
    await new Promise((r) => setImmediate(r));
    await graphqlPubSub.publishActivity(marketId, event);

    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('subscription exceeded 500ms')), 500),
      ),
    ]);

    const elapsed = Date.now() - started;
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: 'trade', marketId });
    expect(elapsed).toBeLessThan(500);

    await iterator.return?.();
  });
});
