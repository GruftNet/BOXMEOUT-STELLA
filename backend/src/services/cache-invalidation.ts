import { invalidate, invalidatePattern } from './multi-level-cache';
import { logger } from '../utils/logger';

// Called by the bet placement flow once a bet is confirmed: the market's pool
// (price) and metadata views, and the bettor's balance, all go stale immediately.
export async function onBetPlaced(marketId: string, bettorAddress: string): Promise<void> {
  await Promise.all([
    invalidate(`price:${marketId}`),
    invalidate(`market:${marketId}`),
    invalidate(`balance:${bettorAddress}`),
  ]);
  logger.info({ marketId, bettorAddress }, 'cache invalidated: bet placed');
}

// Called by the oracle/indexer flow when a market resolves: metadata, price and
// any leaderboard aggregates that include this market's outcome go stale.
export async function onMarketResolved(marketId: string): Promise<void> {
  await Promise.all([
    invalidate(`market:${marketId}`),
    invalidate(`price:${marketId}`),
    invalidatePattern('leaderboard:*'),
  ]);
  logger.info({ marketId }, 'cache invalidated: market resolved');
}

export async function onMarketCreated(): Promise<void> {
  await invalidatePattern('markets:open:list*');
  logger.info('cache invalidated: market created');
}

export async function onMarketLocked(marketId: string): Promise<void> {
  await Promise.all([
    invalidatePattern('markets:open:list*'),
    invalidate(`market:${marketId}`),
  ]);
  logger.info({ marketId }, 'cache invalidated: market locked');
}

export async function onDisputeResolved(marketId: string): Promise<void> {
  await invalidate(`market:${marketId}`);
  logger.info({ marketId }, 'cache invalidated: dispute resolved');
}
