// ============================================================
// BOXMEOUT — Stellar Blockchain Indexer
//
// Listens to the Stellar network for contract events emitted
// by MarketFactory, Market, and Treasury contracts.
// Persists all relevant state changes to the PostgreSQL DB.
//
// Supports horizontal scaling via Redis leader election:
// only the elected leader streams ledgers; standbys take over
// within one TTL window on leader failure.
// ============================================================

import os from 'os';
import { pool } from '../config/db';
import { redis } from '../config/redis';
import { rpc, Address, xdr } from '@stellar/stellar-sdk';
import * as Sentry from '@sentry/node';
import { subscribeToContractEvents, fetchHistoricalEvents } from '../services/StellarService';
import { cacheDeletePattern } from '../services/cache.service';
import { publishEvent } from '../websocket/realtime';
import { logger } from '../utils/logger';
import { LeaderElection } from './LeaderElection';
import {
  indexerIsLeader,
  indexerLedgerLag,
  indexerEventsProcessedTotal,
} from '../services/metrics.service';


// Raw event shape returned by Stellar RPC / Horizon
export interface RawStellarEvent {
  contract_address: string;
  event_type: string;
  topics: string[];
  data: string; // JSON-encoded flat event payload
  ledger_sequence: number;
  ledger_close_time: string;
  tx_hash: string;
}

// Structured summary returned by gap-replay operations.
export interface ReplayResult {
  gap_size: number;
  replayed_events: number;
  skipped_duplicates: number;
  duration_ms: number;
}

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const FACTORY_CONTRACT = process.env.FACTORY_CONTRACT_ADDRESS || '';
const TREASURY_CONTRACT = process.env.TREASURY_CONTRACT_ADDRESS || '';

// No more than 1 replay batch per second, to avoid throttling by Horizon/RPC.
const REPLAY_BATCH_INTERVAL_MS = 1000;

function getReplayBatchSize(): number {
  return Number(process.env.INDEXER_REPLAY_BATCH_SIZE ?? 50);
}

function getMaxReplayLedgers(): number {
  return Number(process.env.INDEXER_MAX_REPLAY_LEDGERS ?? 10000);
}

const server = new rpc.Server(RPC_URL);

// ---------------------------------------------------------------------------
// StellarIndexerService — start/stop lifecycle for the active-leader instance
// ---------------------------------------------------------------------------

class StellarIndexerService {
  private pollTimer?: ReturnType<typeof setInterval>;
  private unsubscribeFn?: () => void;
  private lastProcessed = 0;
  private processing = false;
  private readonly pollIntervalMs: number;

  constructor(private readonly election: LeaderElection) {
    this.pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  }

  async start(): Promise<void> {
    // Prefer the shared Redis cursor so a newly elected leader picks up
    // exactly where the previous one left off without a DB round-trip.
    const redisLedger = await this.election.getLastLedger();
    const dbLedger = await getLastProcessedLedger();
    this.lastProcessed = redisLedger ?? dbLedger;

  // Detect any gap accumulated since the last shutdown and replay it. Runs in
  // the background so it never blocks the live subscription started below.
  void detectAndReplayGap().catch(err => {
    logger.error({ err }, '[Indexer] Gap replay failed');
  });

  // Subscribe to real-time events
  console.log(`[Indexer] Starting real-time subscription from ledger ${lastProcessed}`);
  const unsubscribe = subscribeToContractEvents(FACTORY_CONTRACT, async (event: unknown) => {
    try {
      const eventData = event as Record<string, unknown>;
      const rawEvent: RawStellarEvent = {
        contract_address: (eventData.contract_address as string) || FACTORY_CONTRACT,
        event_type: (eventData.type as string) || 'unknown',
        topics: (eventData.topics as string[]) || [],
        data: JSON.stringify(event),
        ledger_sequence: (eventData.ledger as number) || 0,
        ledger_close_time: (eventData.ledger_close_time as string) || new Date().toISOString(),
        tx_hash: (eventData.tx_hash as string) || '',
      };
      await processEvent(rawEvent);
    } catch (err) {
      console.error('[Indexer] Error processing real-time event:', err);
    }
  });

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Indexer] SIGTERM received, shutting down gracefully');
    unsubscribe();
    process.exit(0);
  });

    logger.info({
      event: 'indexer_start',
      instance_id: this.election.instanceId,
      from_ledger: this.lastProcessed,
    });

    // Gap-recovery: replay any ledgers the previous leader may have missed.
    try {
      const resp = await server.getLatestLedger();
      const latest = resp.sequence;
      if (latest > this.lastProcessed) {
        logger.info({ event: 'indexer_backfill', from: this.lastProcessed + 1, to: latest });
        await backfillLedgerRange(this.lastProcessed + 1, latest, 100);
        this.lastProcessed = latest;
        await this.election.setLastLedger(latest);
        await saveCheckpoint(latest);
      }
    } catch (err) {
      logger.error({ err }, '[Indexer] Backfill error on start');
    }
      // Re-sync with the checkpoint table in case the background gap replay
      // advanced it past this loop's local `lastProcessed` value.
      lastProcessed = Math.max(lastProcessed, await getLastProcessedLedger());

      const latestLedgerResponse = await server.getLatestLedger();
      const latestLedger = latestLedgerResponse.sequence;

    // Real-time subscription (best-effort; polling is the authoritative path).
    this.unsubscribeFn = subscribeToContractEvents(FACTORY_CONTRACT, async (event: unknown) => {
      try {
        const eventData = event as Record<string, unknown>;
        const rawEvent: RawStellarEvent = {
          contract_address: (eventData.contract_address as string) || FACTORY_CONTRACT,
          event_type: (eventData.type as string) || 'unknown',
          topics: (eventData.topics as string[]) || [],
          data: JSON.stringify(event),
          ledger_sequence: (eventData.ledger as number) || 0,
          ledger_close_time: (eventData.ledger_close_time as string) || new Date().toISOString(),
          tx_hash: (eventData.tx_hash as string) || '',
        };
        await processEvent(rawEvent);
        indexerEventsProcessedTotal.inc();
      } catch (err) {
        logger.error({ err }, '[Indexer] Real-time event error');
      }
    });

    // Authoritative poll loop — uses setInterval to avoid blocking the event loop.
    this.pollTimer = setInterval(async () => {
      if (this.processing) return;
      this.processing = true;
      try {
        const resp = await server.getLatestLedger();
        const latest = resp.sequence;
        indexerLedgerLag.set(Math.max(0, latest - this.lastProcessed));

        for (let seq = this.lastProcessed + 1; seq <= latest; seq++) {
          await processLedger(seq);
          await saveCheckpoint(seq);
          await this.election.setLastLedger(seq);
          this.lastProcessed = seq;
          indexerEventsProcessedTotal.inc();
        }
      } catch (err) {
        logger.error({ err }, '[Indexer] Poll error');
      } finally {
        this.processing = false;
      }
    }, this.pollIntervalMs);

    indexerIsLeader.set(1);
  }

  async stop(): Promise<void> {
    logger.info({ event: 'indexer_stop', instance_id: this.election.instanceId });

    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = undefined;
    }
    indexerIsLeader.set(0);
  }
}

// ---------------------------------------------------------------------------
// startIndexer — entry point with distributed leader election
// ---------------------------------------------------------------------------

export async function startIndexer(): Promise<void> {
  const leaseTtl = Number(process.env.INDEXER_LEASE_TTL_SECS ?? 10);
  const leaseRefresh = Number(process.env.INDEXER_LEASE_REFRESH_SECS ?? 5);
  // Default instance ID to hostname so containers get stable identities automatically.
  const instanceId = process.env.INDEXER_INSTANCE_ID || os.hostname();

  if (leaseRefresh >= leaseTtl / 2) {
    throw new Error(
      `INDEXER_LEASE_REFRESH_SECS (${leaseRefresh}) must be strictly less than ` +
      `INDEXER_LEASE_TTL_SECS / 2 (${leaseTtl / 2}) to prevent accidental expiry`,
    );
  }

  const election = new LeaderElection(redis, instanceId, leaseTtl, leaseRefresh);
  const indexer = new StellarIndexerService(election);
  let isLeader = false;

  const tryAcquire = async (): Promise<void> => {
    if (isLeader) return;
    try {
      const acquired = await election.acquireLease();
      if (!acquired) return;

      isLeader = true;
      await indexer.start();

      election.startRenewal(async () => {
        isLeader = false;
        await indexer.stop();
      });
    } catch (err) {
      logger.error({ err }, '[Indexer] Election error');
    }
  };

  // Attempt immediately, then poll every leaseRefresh seconds.
  await tryAcquire();
  setInterval(() => { void tryAcquire(); }, leaseRefresh * 1000);

  const shutdown = async (): Promise<void> => {
    election.stopRenewal();
    if (isLeader) {
      await indexer.stop();
      await election.releaseLease();
    }
  };

  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGINT',  () => { void shutdown().then(() => process.exit(0)); });
}

// ---------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------

/** Safely extract a string value from an xdr.ScVal. */
function scvToString(scv: xdr.ScVal): string {
  const s = scv as any;
  const arm: string = s.arm();
  switch (arm) {
    case 'sym':   return s.sym().toString();
    case 'str':   return s.str().toString();
    case 'u32':
    case 'i32':
    case 'u64':
    case 'i64':
    case 'b':     return String(s[arm]());
    case 'address': return Address.fromScVal(scv).toString();
    case 'void':  return '';
    default: {
      if (arm === 'i128' || arm === 'u128') {
        const parts = s[arm]();
        const hi = BigInt(parts._attributes?._value ?? 0);
        const lo = BigInt(parts._maxDepth?._value ?? 0);
        const signedHi = arm === 'i128' && hi >= 2n ** 63n ? hi - 2n ** 64n : hi;
        return ((signedHi << 64n) + lo).toString();
      }
      const val = s[arm]?.();
      return val != null ? String(val) : scv.toString();
    }
  }
}

/** Recursively convert an xdr.ScVal to a plain JS value. */
function scvToNative(scv: xdr.ScVal): unknown {
  const s = scv as any;
  const arm: string = s.arm();
  switch (arm) {
    case 'sym':   return s.sym().toString();
    case 'str':   return s.str().toString();
    case 'b':     return s.b();
    case 'u32':   return s.u32();
    case 'i32':   return s.i32();
    case 'u64':   return String(s.u64());
    case 'i64':   return String(s.i64());
    case 'address': return Address.fromScVal(scv).toString();
    case 'void':  return null;
    case 'vec':   return s.vec().map(scvToNative);
    case 'map': {
      const result: Record<string, unknown> = {};
      s.map().forEach((entry: any) => {
        result[String(scvToNative(entry.key()))] = scvToNative(entry.val());
      });
      return result;
    }
    case 'i128':
    case 'u128': {
      const parts = s[arm]();
      const hi = BigInt(parts._attributes?._value ?? 0);
      const lo = BigInt(parts._maxDepth?._value ?? 0);
      const signedHi = arm === 'i128' && hi >= 2n ** 63n ? hi - 2n ** 64n : hi;
      return ((signedHi << 64n) + lo).toString();
    }
    default:      return scv.toString();
  }
}

/**
 * Map of Soroban event type (snake_case) → flat JSON field selectors.
 *
 * Each entry lists the fields expected by the handler and how to extract them
 * from the ScVal topics/value. The selectors use dot‑separated paths:
 *   "topic.1"       → topic at index 1 (market_id)
 *   "data.0"        → data array at index 0 (first field of the tuple/struct)
 *   "data.to_string" → data as a plain string (not an array)
 */
const EVENT_FIELD_MAP: Record<string, Array<[string, string]>> = {
  market_created: [
    ['market_id',       'topic.1'],
    ['contract_address','data.0'],
    ['match_id',        'data.1'],
  ],
  market_locked: [
    ['market_id', 'topic.1'],
  ],
  market_resolved: [
    ['market_id',     'topic.1'],
    ['outcome',       'data.0'],
    ['oracle_address','data.1'],
  ],
  bet_placed: [
    ['market_id',       'topic.1'],
    ['bettor_address',  'data.0'],
    ['side',            'data.2'],
    ['amount',          'data.3'],
    ['placed_at',       'data.4'],
    ['claimed',         'data.5'],
  ],
  winnings_claimed: [
    ['market_id',      'topic.1'],
    ['bettor_address', 'data.0'],
    ['payout',         'data.2'],
  ],
  refund_claimed: [
    ['market_id',       'topic.1'],
    ['bettor_address',  'data.0'],
    ['refund_amount',   'data.1'],
  ],
  market_cancelled: [
    ['market_id', 'topic.1'],
  ],
};

/**
 * Build a flat JSON record from ScVal topics and value for a given event type.
 *
 * The returned record is then JSON.stringify'd into RawStellarEvent.data
 * so that existing handlers (which call parsePayload) can read by field name.
 */
function buildEventPayload(
  eventType: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const fields = EVENT_FIELD_MAP[eventType];
  if (!fields) return record; // unknown event → empty record

  // Decode the data value (mostly a Vec or single value)
  const nativeData = scvToNative(value) as unknown[] | string | null;

  for (const [fieldName, selector] of fields) {
    if (selector === 'topic.1') {
      record[fieldName] = topics[1] ? scvToString(topics[1]) : '';
    } else if (selector.startsWith('data.')) {
      const idx = parseInt(selector.slice(5), 10);
      record[fieldName] = Array.isArray(nativeData) ? String(nativeData[idx] ?? '') : '';
    } else if (selector === 'data.to_string') {
      record[fieldName] = typeof nativeData === 'string' ? nativeData : String(nativeData ?? '');
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// Ledger processing
// ---------------------------------------------------------------------------

/**
 * Fetches and decodes the contract events emitted in a single ledger.
 * Shared by the live/backfill path (processLedger) and gap replay
 * (replayLedgerRange), which differ only in how they persist the result.
 */
async function fetchLedgerEvents(ledger_sequence: number): Promise<RawStellarEvent[]> {
  const request: rpc.Api.GetEventsRequest = {
    startLedger: ledger_sequence,
    filters: [
      {
        type: 'contract',
        contractIds: [FACTORY_CONTRACT, TREASURY_CONTRACT],
        topics: [['*']]
      }
    ],
    limit: 100
  };

  const response = await server.getEvents(request);

  if (!response.events || response.events.length === 0) {
    return [];
  }

  return response.events.map((event): RawStellarEvent => {
    const contractId = typeof event.contractId === 'string' ? event.contractId : event.contractId?.toString() || '';

    // Properly extract event type from ScVal Symbol topic
    const eventType = (event.topic[0] as any)?.sym()?.toString() || 'unknown';

    // Build a flat JSON record from ScVal topics + value
    const payload = buildEventPayload(eventType, event.topic, event.value);

    return {
      contract_address: contractId,
      event_type: eventType,
      topics: event.topic.map((t: any) => scvToString(t)),
      data: JSON.stringify(payload),
      ledger_sequence: event.ledger,
      ledger_close_time: event.ledgerClosedAt,
      tx_hash: event.txHash
    };
  });
}

/**
 * Inserts a raw event into blockchain_events, skipping it if the tx_hash
 * already exists. Returns true if a new row was inserted (i.e. this event
 * has not been processed before), false if it was a duplicate.
 */
async function insertEventIfNew(event: RawStellarEvent): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO blockchain_events
       (contract_address, event_type, payload, ledger_sequence, ledger_close_time, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      event.contract_address,
      event.event_type,
      event.data,
      event.ledger_sequence,
      event.ledger_close_time,
      event.tx_hash
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function processLedger(ledger_sequence: number): Promise<void> {
  try {
    const events = await fetchLedgerEvents(ledger_sequence);

    for (const rawEvent of events) {
      // Persist raw event to blockchain_events table — use DO UPDATE so
      // re-indexing during a backfill refreshes stale rows instead of skipping.
      await pool.query(
        `INSERT INTO blockchain_events
           (contract_address, event_type, payload, ledger_sequence, ledger_close_time, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tx_hash) DO UPDATE
           SET contract_address  = EXCLUDED.contract_address,
               event_type        = EXCLUDED.event_type,
               payload           = EXCLUDED.payload,
               ledger_close_time = EXCLUDED.ledger_close_time`,
        [
          rawEvent.contract_address,
          rawEvent.event_type,
          rawEvent.data,
          rawEvent.ledger_sequence,
          rawEvent.ledger_close_time,
          rawEvent.tx_hash
        ]
      );

      // Process the event
      await processEvent(rawEvent);
    }
  } catch (err) {
    console.error(`Error processing ledger ${ledger_sequence}:`, err);
  }
}

/**
 * Replays all missed ledgers in [from_ledger, to_ledger] inclusive.
 *
 * - Fetches each batch of ledgers concurrently via Promise.allSettled so a
 *   single failed fetch doesn't abort the rest of the batch.
 * - Persists each event idempotently (ON CONFLICT (tx_hash) DO NOTHING) and
 *   only routes genuinely-new events through the existing event handlers.
 * - Advances the checkpoint only after a full batch has committed — never
 *   mid-batch — so a crash mid-replay re-does at most one batch.
 * - Rate-limited to one batch per second to avoid Horizon/RPC throttling.
 * - Invalidates the Redis cache for every market touched by a replayed event.
 */
export async function replayLedgerRange(from_ledger: number, to_ledger: number): Promise<ReplayResult> {
  const startTime = Date.now();
  const batchSize = getReplayBatchSize();

  let replayedEvents = 0;
  let skippedDuplicates = 0;
  const affectedMarketIds = new Set<string>();

  for (let batchStart = from_ledger; batchStart <= to_ledger; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize - 1, to_ledger);
    const batchStartedAt = Date.now();

    const sequences: number[] = [];
    for (let seq = batchStart; seq <= batchEnd; seq++) sequences.push(seq);

    const settled = await Promise.allSettled(sequences.map(seq => fetchLedgerEvents(seq)));

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'rejected') {
        logger.error(
          { ledger_sequence: sequences[i], err: outcome.reason },
          '[Indexer] Replay: failed to fetch ledger events',
        );
        continue;
      }

      for (const rawEvent of outcome.value) {
        const isNew = await insertEventIfNew(rawEvent);
        if (!isNew) {
          skippedDuplicates++;
          continue;
        }

        replayedEvents++;
        await processEvent(rawEvent);

        const marketId = parsePayload(rawEvent.data).market_id;
        if (typeof marketId === 'string' && marketId) {
          affectedMarketIds.add(marketId);
        }
      }
    }

    // Checkpoint only advances once the full batch has committed.
    await saveCheckpoint(batchEnd);

    // Rate limit: no more than one batch per second.
    const elapsed = Date.now() - batchStartedAt;
    if (batchEnd < to_ledger && elapsed < REPLAY_BATCH_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, REPLAY_BATCH_INTERVAL_MS - elapsed));
    }
  }

  for (const marketId of affectedMarketIds) {
    await cacheDeletePattern(`market:${marketId}*`);
  }
  if (affectedMarketIds.size > 0) {
    await cacheDeletePattern('markets:*');
  }

  const result: ReplayResult = {
    gap_size: to_ledger - from_ledger + 1,
    replayed_events: replayedEvents,
    skipped_duplicates: skippedDuplicates,
    duration_ms: Date.now() - startTime,
  };

  logger.info(result, '[Indexer] Replay summary');
  return result;
}

/**
 * Compares the indexer's checkpoint against the current Horizon/RPC ledger
 * sequence and replays any missed ledgers (e.g. after a restart or downtime).
 *
 * If the gap exceeds INDEXER_MAX_REPLAY_LEDGERS, replay is skipped entirely,
 * a Sentry warning is raised, and the checkpoint jumps straight to the
 * current ledger so the live subscription isn't stuck waiting on history.
 */
export async function detectAndReplayGap(): Promise<ReplayResult> {
  const lastProcessed = await getLastProcessedLedger();
  const latestLedgerResponse = await server.getLatestLedger();
  const currentLedger = latestLedgerResponse.sequence;
  const gapSize = currentLedger - lastProcessed;

  if (gapSize <= 0) {
    return { gap_size: 0, replayed_events: 0, skipped_duplicates: 0, duration_ms: 0 };
  }

  const maxReplayLedgers = getMaxReplayLedgers();
  if (gapSize > maxReplayLedgers) {
    Sentry.captureMessage(
      `[Indexer] Gap of ${gapSize} ledgers exceeds INDEXER_MAX_REPLAY_LEDGERS ` +
      `(${maxReplayLedgers}); skipping replay and jumping to ledger ${currentLedger}`,
      { level: 'warning' },
    );
    await saveCheckpoint(currentLedger);

    const result: ReplayResult = {
      gap_size: gapSize,
      replayed_events: 0,
      skipped_duplicates: 0,
      duration_ms: 0,
    };
    logger.info(result, '[Indexer] Replay summary (gap exceeded max, skipped)');
    return result;
  }

  logger.info(
    { from: lastProcessed + 1, to: currentLedger, gap_size: gapSize },
    '[Indexer] Detected gap on startup, replaying missed ledgers',
  );
  return replayLedgerRange(lastProcessed + 1, currentLedger);
}

export async function processEvent(event: RawStellarEvent): Promise<void> {
  try {
    const eventType = event.event_type;

    if (eventType === 'market_created') {
      await handleMarketCreated(event);
    } else if (eventType === 'bet_placed') {
      await handleBetPlaced(event);
    } else if (eventType === 'market_locked') {
      await handleMarketLocked(event);
    } else if (eventType === 'market_resolved') {
      await handleMarketResolved(event);
    } else if (eventType === 'market_cancelled') {
      await handleMarketCancelled(event);
    } else if (eventType === 'winnings_claimed') {
      await handleWinningsClaimed(event);
    } else if (eventType === 'refund_claimed') {
      await handleRefundClaimed(event);
    }
  } catch (err) {
    console.error(`Error processing event ${event.tx_hash}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePayload(data: string): Record<string, unknown> {
  try { return JSON.parse(data); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleMarketCreated(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  
  try {
    // Parse event payload into MarketCreatedEvent type
    const marketData = {
      market_id: p.market_id,
      contract_address: event.contract_address,
      match_id: p.match_id ?? '',
      fighter_a: p.fighter_a ?? '',
      fighter_b: p.fighter_b ?? '',
      weight_class: p.weight_class ?? '',
      title_fight: p.title_fight ?? false,
      venue: p.venue ?? '',
      scheduled_at: p.scheduled_at ?? new Date(),
      fee_bps: p.fee_bps ?? 200,
      lock_before_secs: p.lock_before_secs ?? 3600,
      status: 'open',
      ledger_sequence: event.ledger_sequence,
    };

    // Idempotent: does not throw if market already exists
    await pool.query(
      `INSERT INTO markets
         (market_id, contract_address, match_id, fighter_a, fighter_b,
          weight_class, title_fight, venue, scheduled_at, fee_bps, lock_before_secs, status, ledger_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (market_id) DO NOTHING`,
      [
        marketData.market_id,
        marketData.contract_address,
        marketData.match_id,
        marketData.fighter_a,
        marketData.fighter_b,
        marketData.weight_class,
        marketData.title_fight,
        marketData.venue,
        marketData.scheduled_at,
        marketData.fee_bps,
        marketData.lock_before_secs,
        marketData.status,
        marketData.ledger_sequence,
      ],
    );

    console.log(`[Indexer] Market created: ${marketData.market_id}`);
  } catch (err) {
    console.error(`[Indexer] Error handling MarketCreated event:`, err);
    throw err;
  }
}

export async function handleBetPlaced(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO bets
         (market_id, bettor_address, side, amount, amount_xlm, placed_at, tx_hash, ledger_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        p.market_id,
        p.bettor_address,
        p.side,
        p.amount,
        Number(p.amount) / 10_000_000,
        p.placed_at ?? new Date(),
        event.tx_hash,
        event.ledger_sequence,
      ],
    );
    const col = p.side === 'fighter_a' ? 'pool_a' : p.side === 'fighter_b' ? 'pool_b' : 'pool_draw';
    await client.query(
      `UPDATE markets
          SET ${col}      = ${col} + $1,
              total_pool  = total_pool + $1,
              updated_at  = NOW()
        WHERE market_id   = $2`,
      [p.amount, p.market_id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  publishEvent(p.market_id as string, {
    type: 'trade',
    marketId: p.market_id as string,
    outcomeId: p.side as string,
    side: 'buy',
    sharesAmount: Number(p.amount),
    priceBps: 0,
    timestamp: (p.placed_at ?? new Date()).toString(),
  });
}

export async function handleMarketLocked(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1`,
    [p.market_id],
  );
}

export async function handleMarketResolved(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update market status, winning_outcome, and resolved_at
    await client.query(
      `UPDATE markets
          SET status = 'resolved', outcome = $1, resolved_at = $2, oracle_used = $3, updated_at = NOW()
        WHERE market_id = $4`,
      [p.outcome, event.ledger_close_time, p.oracle_address ?? null, p.market_id],
    );

    // Insert OracleReport record
    await client.query(
      `INSERT INTO oracle_reports
         (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT DO NOTHING`,
      [
        p.match_id ?? '',
        p.oracle_address ?? '',
        p.outcome ?? '',
        event.ledger_close_time,
        p.signature ?? '',
        event.tx_hash,
      ],
    );

    // Get all unique bettors for this market
    const { rows: bettors } = await client.query(
      `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
      [p.market_id]
    );

    // Enqueue notification job for each bettor
    for (const bettor of bettors) {
      await client.query(
        `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [bettor.bettor_address, p.market_id, 'market_resolved', 'pending']
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Invalidate all Redis cache keys for this market
  await cacheDeletePattern(`market:${p.market_id}*`);
  await cacheDeletePattern(`markets:*`);

  publishEvent(p.market_id as string, {
    type: 'resolved',
    marketId: p.market_id as string,
    winningOutcomeId: p.outcome as string,
  });
}

export async function handleMarketCancelled(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update market status
    await client.query(
      `UPDATE markets SET status = 'cancelled', updated_at = NOW() WHERE market_id = $1`,
      [p.market_id],
    );

    // Get all unique bettors for this market
    const { rows: bettors } = await client.query(
      `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
      [p.market_id]
    );

    // Enqueue notification job for each bettor
    for (const bettor of bettors) {
      await client.query(
        `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [bettor.bettor_address, p.market_id, 'market_cancelled', 'pending']
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function handleWinningsClaimed(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
    [p.payout ?? null, p.market_id, p.bettor_address],
  );
}

export async function handleRefundClaimed(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
    [p.refund_amount ?? null, p.market_id, p.bettor_address],
  );
}

export async function getLastProcessedLedger(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.last_processed_ledger ?? Number(process.env.GENESIS_LEDGER ?? 0);
}

export async function saveCheckpoint(ledger_sequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_checkpoints (id, last_processed_ledger)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE
       SET last_processed_ledger = EXCLUDED.last_processed_ledger,
           updated_at = NOW()`,
    [ledger_sequence],
  );
}

/**
 * Backfills all ledgers in [from_ledger, to_ledger] inclusive.
 *
 * - Processes ledgers in ascending order.
 * - Fetches events in batches of `batch_size` to avoid memory pressure.
 * - Uses ON CONFLICT DO UPDATE (via processLedger) so re-runs are safe.
 * - Logs progress every 1 000 ledgers and emits a completion summary.
 */
export async function backfillLedgerRange(
  from_ledger: number,
  to_ledger: number,
  batch_size: number,
): Promise<void> {
  const total = to_ledger - from_ledger + 1;
  console.log(
    `[Backfill] Starting — ledgers ${from_ledger}–${to_ledger} ` +
    `(${total} ledgers, batch_size=${batch_size})`,
  );

  let processed = 0;

  for (let batchStart = from_ledger; batchStart <= to_ledger; batchStart += batch_size) {
    const batchEnd = Math.min(batchStart + batch_size - 1, to_ledger);

    for (let seq = batchStart; seq <= batchEnd; seq++) {
      await processLedger(seq);
      processed++;

      if (processed % 1_000 === 0) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(
          `[Backfill] Progress: ${processed}/${total} ledgers processed ` +
          `(${pct}%, current ledger: ${seq})`,
        );
      }
    }

    // Persist checkpoint after every batch so a restart only re-does the last batch
    await saveCheckpoint(batchEnd);
  }

  console.log(`[Backfill] Complete — ${processed} ledgers processed.`);
}

/**
 * Loads the checkpoint from the database.
 * Returns the last processed ledger, or null if no checkpoint exists.
 */
export async function loadCheckpoint(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.last_processed_ledger ?? null;
}

/**
 * Backfills from a given ledger to the latest ledger.
 * Uses fetchHistoricalEvents to get all events and processes them.
 */
export async function backfillFromLedger(fromLedger: number, toLedger?: number): Promise<void> {
  console.log(`[Indexer] Backfilling from ledger ${fromLedger}${toLedger ? ` to ${toLedger}` : ''}`);
  
  const events = await fetchHistoricalEvents(fromLedger, toLedger);
  console.log(`[Indexer] Fetched ${events.length} historical events`);

  for (const event of events) {
    await processEvent(event);
  }

  if (toLedger) {
    await saveCheckpoint(toLedger);
  }
}
