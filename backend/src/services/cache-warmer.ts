import { set } from './cache.service';
import { CACHE_TTL } from '../config/cache-ttl';
import { logger } from '../utils/logger';

export interface WarmableMarket {
  marketId: string;
  metadata: unknown;
}

export interface CacheWarmerDeps {
  loadOpenMarkets: () => Promise<WarmableMarket[]>;
}

// Takes a data loader rather than a DB client directly: the DB access layer
// (backend/src/db) doesn't exist yet, so this stays wireable once it does —
// whatever builds backend/src/index.ts calls warmCache({ loadOpenMarkets }) on boot.
export async function warmCache(deps: CacheWarmerDeps): Promise<number> {
  try {
    const markets = await deps.loadOpenMarkets();

    await Promise.all([
      set(
        'markets:open:list',
        markets.map((m) => m.marketId),
        CACHE_TTL.OPEN_MARKETS_LIST
      ),
      ...markets.map((m) => set(`market:${m.marketId}`, m.metadata, CACHE_TTL.MARKET_METADATA)),
    ]);

    logger.info({ count: markets.length }, 'cache warming complete');
    return markets.length;
  } catch (err) {
    logger.warn({ err }, 'cache warming failed');
    return 0;
  }
}
