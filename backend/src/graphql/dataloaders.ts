import DataLoader from 'dataloader';
import type { Bet } from '../models/Bet';
import type { Market } from '../models/Market';
import {
  getBetsByAddress,
  getBetsByMarket,
  getMarketById,
  getMarketOdds,
  getMarketStats,
  getPortfolioByAddress,
  type MarketOdds,
  type Portfolio,
} from '../services/MarketService';
import type { MarketStats } from '../models/Market';

export interface GraphQLLoaders {
  marketById: DataLoader<string, Market | null>;
  oddsByMarketId: DataLoader<string, MarketOdds | null>;
  statsByMarketId: DataLoader<string, MarketStats | null>;
  betsByMarketId: DataLoader<string, Bet[]>;
  betsByAddress: DataLoader<string, Bet[]>;
  portfolioByAddress: DataLoader<string, Portfolio>;
}

/**
 * Request-scoped DataLoaders — one set per GraphQL operation to batch/cache
 * nested market → bets → user lookups and eliminate N+1 queries.
 */
export function createLoaders(): GraphQLLoaders {
  return {
    marketById: new DataLoader(async (ids) => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const market = await getMarketById(id);
            return market;
          } catch {
            return null;
          }
        }),
      );
      return results;
    }),

    oddsByMarketId: new DataLoader(async (ids) => {
      return Promise.all(
        ids.map(async (id) => {
          try {
            return await getMarketOdds(id);
          } catch {
            return null;
          }
        }),
      );
    }),

    statsByMarketId: new DataLoader(async (ids) => {
      return Promise.all(
        ids.map(async (id) => {
          try {
            return await getMarketStats(id);
          } catch {
            return null;
          }
        }),
      );
    }),

    betsByMarketId: new DataLoader(async (ids) => {
      return Promise.all(ids.map((id) => getBetsByMarket(id)));
    }),

    betsByAddress: new DataLoader(async (addresses) => {
      return Promise.all(addresses.map((address) => getBetsByAddress(address)));
    }),

    portfolioByAddress: new DataLoader(async (addresses) => {
      return Promise.all(addresses.map((address) => getPortfolioByAddress(address)));
    }),
  };
}
