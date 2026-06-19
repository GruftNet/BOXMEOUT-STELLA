import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import {
  connectRedisClients,
  MARKET_EVENTS_PATTERN,
  marketEventChannel,
  parseMarketIdFromChannel,
  redis,
  redisSub,
} from '../config/redis';
import {
  wsConnectedClients,
  wsMessagesDroppedTotal,
  wsMessagesPublishedTotal,
} from '../services/metrics.service';
import { logger } from '../utils/logger';

const BUFFER_THRESHOLD = Number(process.env.WS_BUFFER_THRESHOLD_BYTES ?? 16384);
const HEARTBEAT_INTERVAL_MS = 30_000;
const GOING_AWAY = 1001;

// ---------------------------------------------------------------------------
// Internal event bus — used by BetService to notify RiskEngine of new bets
// without polling. Keeps the risk engine decoupled from the WS layer.
// ---------------------------------------------------------------------------
const _betPlacedBus = new EventEmitter();
_betPlacedBus.setMaxListeners(20);

export function emitBetPlaced(marketId: string): void {
  _betPlacedBus.emit('BetPlaced', marketId);
}

export function onBetPlaced(handler: (marketId: string) => void): void {
  _betPlacedBus.on('BetPlaced', handler);
}

export function offBetPlaced(handler: (marketId: string) => void): void {
  _betPlacedBus.off('BetPlaced', handler);
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
export type ActivityEvent =
  | { type: 'trade'; marketId: string; outcomeId: string; side: string; sharesAmount: number; priceBps: number; timestamp: string }
  | { type: 'dispute'; marketId: string; proposedOutcomeId: string }
  | { type: 'resolved'; marketId: string; winningOutcomeId: string };

type SubscribeMsg = { type: 'subscribe_activity'; marketId: string };

// ---------------------------------------------------------------------------
// Rate limiter — token bucket, max 20 events/sec per market
// ---------------------------------------------------------------------------
const RATE_LIMIT = 20;
const WINDOW_MS = 1_000;

class MarketRateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();

  allow(marketId: string): boolean {
    const now = Date.now();
    let entry = this.counts.get(marketId);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.counts.set(marketId, entry);
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
  }
}

const _rateLimiter = new MarketRateLimiter();
const _feeds = new Set<ActivityFeed>();
let _subscriberReady = false;

/** Publish an activity event to Redis for all cluster instances to forward locally. */
export function publishEvent(marketId: string, event: ActivityEvent): void {
  if (!_rateLimiter.allow(marketId)) return;

  void redis.publish(marketEventChannel(marketId), JSON.stringify(event)).catch((err) => {
    logger.error({ err, marketId }, 'Failed to publish WebSocket event to Redis');
  });
  wsMessagesPublishedTotal.inc();
}

async function ensureRedisSubscriber(): Promise<void> {
  if (_subscriberReady) return;

  await redisSub.psubscribe(MARKET_EVENTS_PATTERN);
  redisSub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const marketId = parseMarketIdFromChannel(channel);
    if (!marketId) return;

    for (const feed of _feeds) {
      feed.forwardToLocalClients(marketId, message);
    }
  });

  _subscriberReady = true;
  logger.info('Redis pub/sub subscriber listening on market:*:events');
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------
export class ActivityFeed {
  private wss: WebSocketServer;
  // marketId → set of subscribed sockets
  private subscriptions = new Map<string, Set<WebSocket>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private acceptingConnections = true;
  private shutDown = false;

  constructor(server: Server) {
    this.wss = new WebSocketServer({
      server,
      verifyClient: (_info, done) => done(this.acceptingConnections),
    });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      wsConnectedClients.inc();
      (ws as WebSocket & { isAlive: boolean }).isAlive = true;

      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('pong', () => {
        (ws as WebSocket & { isAlive: boolean }).isAlive = true;
      });
      ws.on('close', () => {
        wsConnectedClients.dec();
        this.removeSocket(ws);
      });
    });

    this.heartbeatTimer = setInterval(() => this.pingClients(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    _feeds.add(this);
    logger.info('ActivityFeed WebSocket server attached');
  }

  private pingClients(): void {
    for (const client of this.wss.clients) {
      const ws = client as WebSocket & { isAlive: boolean };
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, marketId } = msg as SubscribeMsg;
    if (type !== 'subscribe_activity' || typeof marketId !== 'string') return;

    if (!this.subscriptions.has(marketId)) {
      this.subscriptions.set(marketId, new Set());
    }
    this.subscriptions.get(marketId)!.add(ws);
  }

  private removeSocket(ws: WebSocket): void {
    for (const sockets of this.subscriptions.values()) {
      sockets.delete(ws);
    }
  }

  /** Forward a Redis pub/sub payload to locally connected subscribers of the market. */
  forwardToLocalClients(marketId: string, payload: string): void {
    const sockets = this.subscriptions.get(marketId);
    if (!sockets?.size) return;

    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (ws.bufferedAmount > BUFFER_THRESHOLD) {
        wsMessagesDroppedTotal.inc();
        continue;
      }

      ws.send(payload);
    }
  }

  /** Publish an activity event via Redis (backward-compatible wrapper). */
  publish(event: ActivityEvent): void {
    const { marketId } = event as { marketId: string };
    publishEvent(marketId, event);
  }

  async shutdown(): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;
    this.acceptingConnections = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const ws of this.wss.clients) {
      ws.close(GOING_AWAY, 'Going Away');
    }

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });

    this.subscriptions.clear();
    _feeds.delete(this);

    if (_feeds.size === 0 && _subscriberReady) {
      await redisSub.punsubscribe(MARKET_EVENTS_PATTERN);
      _subscriberReady = false;
    }
  }

  close(): void {
    void this.shutdown();
  }
}

// Singleton — initialised once in src/index.ts
let _feed: ActivityFeed | null = null;

export async function initActivityFeed(server: Server): Promise<ActivityFeed> {
  await connectRedisClients();
  await ensureRedisSubscriber();
  _feed = new ActivityFeed(server);
  return _feed;
}

export function getActivityFeed(): ActivityFeed {
  if (!_feed) throw new Error('ActivityFeed not initialised');
  return _feed;
}

export async function shutdownActivityFeed(): Promise<void> {
  if (!_feed) return;

  await _feed.shutdown();
  _feed = null;
}

/** Test helper: wire Redis subscriber without creating the singleton feed. */
export async function initRedisSubscriberForTest(feed: ActivityFeed): Promise<void> {
  await connectRedisClients();
  await ensureRedisSubscriber();
  _feeds.add(feed);
}

export { redisSub, BUFFER_THRESHOLD };
