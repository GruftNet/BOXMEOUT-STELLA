import { graphqlPubSub } from '../../src/graphql/pubsub';
import type { ActivityEvent } from '../../src/websocket/realtime';

describe('GraphQL subscription local fan-out', () => {
  afterEach(async () => {
    await graphqlPubSub.shutdown();
  });

  it('delivers marketActivity via local emit in under 500ms', async () => {
    const marketId = 'local-mkt-1';
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
    graphqlPubSub.emitLocal(marketId, event);

    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('subscription exceeded 500ms')), 500),
      ),
    ]);

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.value).toMatchObject({ type: 'trade', marketId });
    await iterator.return?.();
  });
});
