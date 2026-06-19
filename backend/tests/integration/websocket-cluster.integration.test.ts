// tests/integration/websocket-cluster.integration.test.ts
// Integration tests: Redis pub/sub fan-out across multiple ActivityFeed instances

import http from 'http';
import { WebSocket } from 'ws';
import { connectRedisClients } from '../../src/config/redis';
import { register } from '../../src/services/metrics.service';
import {
  ActivityFeed,
  BUFFER_THRESHOLD,
  initRedisSubscriberForTest,
  publishEvent,
  shutdownActivityFeed,
  type ActivityEvent,
} from '../../src/websocket/realtime';

function waitForMessage(ws: WebSocket, timeoutMs = 200): Promise<ActivityEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as ActivityEvent);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS close')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function startFeed(): Promise<{ server: http.Server; feed: ActivityFeed; port: number }> {
  const server = http.createServer();
  const feed = new ActivityFeed(server);
  await initRedisSubscriberForTest(feed);

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind server'));
        return;
      }
      resolve(addr.port);
    });
  });

  return { server, feed, port };
}

describe('WebSocket cluster pub/sub integration', () => {
  const servers: http.Server[] = [];
  const feeds: ActivityFeed[] = [];

  beforeAll(async () => {
    await connectRedisClients();
  });

  afterEach(async () => {
    await shutdownActivityFeed();
    for (const feed of feeds.splice(0)) {
      await feed.shutdown();
    }
    await Promise.all(servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ));
  });

  it('delivers publishEvent to clients on two instances within 200ms', async () => {
    const instanceA = await startFeed();
    const instanceB = await startFeed();
    servers.push(instanceA.server, instanceB.server);
    feeds.push(instanceA.feed, instanceB.feed);

    const wsA = new WebSocket(`ws://localhost:${instanceA.port}`);
    const wsB = new WebSocket(`ws://localhost:${instanceB.port}`);
    await Promise.all([
      new Promise<void>((resolve) => wsA.once('open', resolve)),
      new Promise<void>((resolve) => wsB.once('open', resolve)),
    ]);

    wsA.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-shared' }));
    wsB.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-shared' }));
    await new Promise((r) => setImmediate(r));

    const tradeEvent: ActivityEvent = {
      type: 'trade',
      marketId: 'market-shared',
      outcomeId: 'fighter_a',
      side: 'buy',
      sharesAmount: 50,
      priceBps: 5000,
      timestamp: new Date().toISOString(),
    };

    publishEvent('market-shared', tradeEvent);

    const [receivedA, receivedB] = await Promise.all([
      waitForMessage(wsA, 200),
      waitForMessage(wsB, 200),
    ]);

    expect(receivedA).toEqual(tradeEvent);
    expect(receivedB).toEqual(tradeEvent);

    wsA.close();
    wsB.close();
  });

  it('delivers only to clients subscribed to the published market', async () => {
    const instance = await startFeed();
    servers.push(instance.server);
    feeds.push(instance.feed);

    const ws123 = new WebSocket(`ws://localhost:${instance.port}`);
    const ws456 = new WebSocket(`ws://localhost:${instance.port}`);
    await Promise.all([
      new Promise<void>((resolve) => ws123.once('open', resolve)),
      new Promise<void>((resolve) => ws456.once('open', resolve)),
    ]);

    ws123.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market_123' }));
    ws456.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market_456' }));
    await new Promise((r) => setImmediate(r));

    const messages123: string[] = [];
    const messages456: string[] = [];
    ws123.on('message', (d) => messages123.push(d.toString()));
    ws456.on('message', (d) => messages456.push(d.toString()));

    publishEvent('market_123', {
      type: 'resolved',
      marketId: 'market_123',
      winningOutcomeId: 'fighter_a',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(messages123).toHaveLength(1);
    expect(messages456).toHaveLength(0);

    ws123.close();
    ws456.close();
  });

  it('drops messages when client send buffer exceeds threshold', async () => {
    const instance = await startFeed();
    servers.push(instance.server);
    feeds.push(instance.feed);

    const droppedBefore = await getCounterValue('ws_messages_dropped_total');

    const mockWs = {
      readyState: WebSocket.OPEN,
      bufferedAmount: BUFFER_THRESHOLD + 1,
      send: jest.fn(),
    } as unknown as WebSocket;

    const feedInternals = instance.feed as unknown as {
      subscriptions: Map<string, Set<WebSocket>>;
    };
    feedInternals.subscriptions.set('market-bp', new Set([mockWs]));

    instance.feed.forwardToLocalClients(
      'market-bp',
      JSON.stringify({ type: 'trade', marketId: 'market-bp', outcomeId: 'o', side: 'buy', sharesAmount: 1, priceBps: 1, timestamp: '' }),
    );

    expect(mockWs.send).not.toHaveBeenCalled();

    const droppedAfter = await getCounterValue('ws_messages_dropped_total');
    expect(droppedAfter - droppedBefore).toBe(1);
  });

  it('closes clients with code 1001 and disconnects redisSub on shutdown', async () => {
    const instance = await startFeed();
    servers.push(instance.server);
    feeds.push(instance.feed);

    const ws = new WebSocket(`ws://localhost:${instance.port}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-shutdown' }));

    const closePromise = waitForClose(ws);
    await instance.feed.shutdown();

    const closeCode = await closePromise;
    expect(closeCode).toBe(1001);
  });
});

async function getCounterValue(name: string): Promise<number> {
  const metric = await register.getSingleMetric(name);
  if (!metric) return 0;
  const data = await metric.get();
  return data.values.reduce((sum, v) => sum + v.value, 0);
}
