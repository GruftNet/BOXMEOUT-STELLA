import type { ActivityEvent } from '../websocket/realtime';
import {
  getBetsByAddress,
  getBetsByMarket,
  getMarkets,
  getPlatformStats,
  type MarketFilters,
} from '../services/MarketService';
import type { GraphQLContext } from './context';
import {
  aggregatePositions,
  betToTrade,
  mapBet,
  mapMarket,
  mapOdds,
  mapPortfolio,
  mapStats,
} from './mappers';
import { decodeCursor, encodeCursor } from './pagination';
import {
  GRAPHQL_MARKET_UPDATED,
  GRAPHQL_TRADE_CREATED,
  graphqlPubSub,
} from './pubsub';
import { DEPRECATED_FIELDS, MIN_COMPATIBLE_VERSION, SCHEMA_VERSION } from './version';

type MarketParent = ReturnType<typeof mapMarket>;
type BetParent = ReturnType<typeof mapBet>;

function slicePage<T>(items: T[], limit: number, offset: number): T[] {
  return items.slice(offset, offset + limit);
}

function compareMarkets(
  a: { scheduledAt: string; totalPool: string; createdAt: string; marketId: string },
  b: typeof a,
  field: string,
  direction: string,
): number {
  const dir = direction === 'ASC' ? 1 : -1;
  let cmp = 0;
  switch (field) {
    case 'TOTAL_POOL': {
      try {
        const aPool = BigInt(a.totalPool);
        const bPool = BigInt(b.totalPool);
        cmp = aPool > bPool ? 1 : aPool < bPool ? -1 : 0;
      } catch {
        cmp = Number(a.totalPool) - Number(b.totalPool);
      }
      break;
    }
    case 'CREATED_AT':
      cmp = a.createdAt.localeCompare(b.createdAt);
      break;
    case 'SCHEDULED_AT':
    default:
      cmp = a.scheduledAt.localeCompare(b.scheduledAt);
      break;
  }
  if (cmp === 0) cmp = a.marketId.localeCompare(b.marketId);
  return cmp * dir;
}

export const resolvers = {
  Query: {
    schemaInfo: () => ({
      version: SCHEMA_VERSION,
      minCompatibleVersion: MIN_COMPATIBLE_VERSION,
      deprecatedFields: [...DEPRECATED_FIELDS],
    }),

    market: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const market = await ctx.loaders.marketById.load(args.id);
      return market ? mapMarket(market) : null;
    },

    markets: async (
      _: unknown,
      args: {
        filter?: {
          status?: string;
          weightClass?: string;
          fighter?: string;
          dateFrom?: string;
          dateTo?: string;
          titleFight?: boolean;
          venue?: string;
          marketIds?: string[];
        };
        sort?: { field?: string; direction?: string };
        page?: number;
        limit?: number;
        first?: number;
        after?: string;
      },
    ) => {
      const filters: MarketFilters = {
        status: args.filter?.status,
        weight_class: args.filter?.weightClass,
        fighter: args.filter?.fighter,
        dateFrom: args.filter?.dateFrom ? new Date(args.filter.dateFrom) : undefined,
        dateTo: args.filter?.dateTo ? new Date(args.filter.dateTo) : undefined,
      };

      // Fetch a wide page from the service, then apply GraphQL-only filters/sort/cursors.
      const { markets } = await getMarkets(filters, { page: 1, limit: 1_000 });
      let nodes = markets.map(mapMarket);

      if (args.filter?.titleFight !== undefined && args.filter?.titleFight !== null) {
        nodes = nodes.filter((m) => m.titleFight === args.filter!.titleFight);
      }
      if (args.filter?.venue) {
        const venue = args.filter.venue.toLowerCase();
        nodes = nodes.filter((m) => m.venue.toLowerCase().includes(venue));
      }
      if (args.filter?.marketIds?.length) {
        const ids = new Set(args.filter.marketIds);
        nodes = nodes.filter((m) => ids.has(m.marketId));
      }

      const sortField = args.sort?.field ?? 'SCHEDULED_AT';
      const sortDir = args.sort?.direction ?? 'DESC';
      nodes = [...nodes].sort((a, b) => compareMarkets(a, b, sortField, sortDir));

      const totalCount = nodes.length;
      const useCursor = args.first != null || args.after != null;

      if (useCursor) {
        const first = Math.min(args.first ?? 50, 100);
        let start = 0;
        if (args.after) {
          const cursor = decodeCursor(args.after);
          const idx = nodes.findIndex(
            (m) => m.marketId === cursor.marketId && m.scheduledAt === cursor.scheduledAt,
          );
          start = idx >= 0 ? idx + 1 : 0;
        }
        const pageNodes = nodes.slice(start, start + first);
        const edges = pageNodes.map((node) => ({
          cursor: encodeCursor(node.marketId, node.scheduledAt),
          node,
        }));
        return {
          edges,
          pageInfo: {
            hasNextPage: start + first < totalCount,
            hasPreviousPage: start > 0,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: edges[edges.length - 1]?.cursor ?? null,
            totalCount,
          },
        };
      }

      const page = Math.max(args.page ?? 1, 1);
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
      const offset = (page - 1) * limit;
      const pageNodes = nodes.slice(offset, offset + limit);
      const edges = pageNodes.map((node) => ({
        cursor: encodeCursor(node.marketId, node.scheduledAt),
        node,
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
          totalCount,
        },
      };
    },

    bets: async (
      _: unknown,
      args: { marketId?: string; bettorAddress?: string; limit?: number; offset?: number },
    ) => {
      let bets = args.marketId
        ? await getBetsByMarket(args.marketId, args.bettorAddress)
        : args.bettorAddress
          ? await getBetsByAddress(args.bettorAddress)
          : [];
      if (args.marketId && args.bettorAddress) {
        bets = bets.filter((b) => b.bettor_address === args.bettorAddress);
      }
      return slicePage(bets.map(mapBet), args.limit ?? 50, args.offset ?? 0);
    },

    positions: async (
      _: unknown,
      args: { marketId?: string; ownerAddress?: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      let bets = args.marketId
        ? await ctx.loaders.betsByMarketId.load(args.marketId)
        : args.ownerAddress
          ? await ctx.loaders.betsByAddress.load(args.ownerAddress)
          : [];
      if (args.ownerAddress) {
        bets = bets.filter((b) => b.bettor_address === args.ownerAddress);
      }
      if (args.marketId) {
        bets = bets.filter((b) => b.market_id === args.marketId);
      }
      return slicePage(aggregatePositions(bets), args.limit ?? 50, args.offset ?? 0);
    },

    trades: async (
      _: unknown,
      args: { marketId?: string; traderAddress?: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      let bets = args.marketId
        ? await ctx.loaders.betsByMarketId.load(args.marketId)
        : args.traderAddress
          ? await ctx.loaders.betsByAddress.load(args.traderAddress)
          : [];
      if (args.traderAddress) {
        bets = bets.filter((b) => b.bettor_address === args.traderAddress);
      }
      return slicePage(bets.map((b) => betToTrade(b)), args.limit ?? 50, args.offset ?? 0);
    },

    user: (_: unknown, args: { address: string }) => ({ address: args.address }),

    portfolio: async (_: unknown, args: { address: string }, ctx: GraphQLContext) => {
      const portfolio = await ctx.loaders.portfolioByAddress.load(args.address);
      return mapPortfolio(portfolio);
    },

    platformStats: async () => {
      const stats = await getPlatformStats();
      return {
        totalMarkets: stats.totalMarkets,
        activeMarkets: stats.activeMarkets,
        totalVolume: stats.totalVolume,
        totalBets: stats.totalBets,
      };
    },
  },

  Market: {
    odds: async (parent: MarketParent, _: unknown, ctx: GraphQLContext) => {
      const odds = await ctx.loaders.oddsByMarketId.load(parent.marketId);
      if (!odds) {
        return mapOdds({ odds_a: 3333, odds_b: 3333, odds_draw: 3334 });
      }
      return mapOdds(odds);
    },
    stats: async (parent: MarketParent, _: unknown, ctx: GraphQLContext) => {
      const stats = await ctx.loaders.statsByMarketId.load(parent.marketId);
      return stats ? mapStats(stats) : null;
    },
    bets: async (
      parent: MarketParent,
      args: { limit?: number; offset?: number; bettorAddress?: string },
      ctx: GraphQLContext,
    ) => {
      let bets = await ctx.loaders.betsByMarketId.load(parent.marketId);
      if (args.bettorAddress) {
        bets = bets.filter((b) => b.bettor_address === args.bettorAddress);
      }
      return slicePage(bets.map(mapBet), args.limit ?? 50, args.offset ?? 0);
    },
    positions: async (
      parent: MarketParent,
      args: { limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const bets = await ctx.loaders.betsByMarketId.load(parent.marketId);
      return slicePage(aggregatePositions(bets), args.limit ?? 50, args.offset ?? 0);
    },
    trades: async (
      parent: MarketParent,
      args: { limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const bets = await ctx.loaders.betsByMarketId.load(parent.marketId);
      return slicePage(bets.map((b) => betToTrade(b)), args.limit ?? 50, args.offset ?? 0);
    },
  },

  Bet: {
    market: async (parent: BetParent, _: unknown, ctx: GraphQLContext) => {
      const market = await ctx.loaders.marketById.load(parent.marketId);
      return market ? mapMarket(market) : null;
    },
    user: (parent: BetParent) => ({ address: parent.bettorAddress }),
  },

  Position: {
    market: async (
      parent: { marketId: string },
      _: unknown,
      ctx: GraphQLContext,
    ) => {
      const market = await ctx.loaders.marketById.load(parent.marketId);
      return market ? mapMarket(market) : null;
    },
    user: (parent: { ownerAddress: string }) => ({ address: parent.ownerAddress }),
  },

  Trade: {
    market: async (
      parent: { marketId: string },
      _: unknown,
      ctx: GraphQLContext,
    ) => {
      const market = await ctx.loaders.marketById.load(parent.marketId);
      return market ? mapMarket(market) : null;
    },
    user: (parent: { traderAddress: string }) => ({ address: parent.traderAddress }),
  },

  User: {
    bets: async (
      parent: { address: string },
      args: { limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const bets = await ctx.loaders.betsByAddress.load(parent.address);
      return slicePage(bets.map(mapBet), args.limit ?? 50, args.offset ?? 0);
    },
    positions: async (
      parent: { address: string },
      args: { limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const bets = await ctx.loaders.betsByAddress.load(parent.address);
      return slicePage(aggregatePositions(bets), args.limit ?? 50, args.offset ?? 0);
    },
    trades: async (
      parent: { address: string },
      args: { limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const bets = await ctx.loaders.betsByAddress.load(parent.address);
      return slicePage(bets.map((b) => betToTrade(b)), args.limit ?? 50, args.offset ?? 0);
    },
    portfolio: async (parent: { address: string }, _: unknown, ctx: GraphQLContext) => {
      const portfolio = await ctx.loaders.portfolioByAddress.load(parent.address);
      return mapPortfolio(portfolio);
    },
  },

  Subscription: {
    marketActivity: {
      subscribe: (_: unknown, args: { marketId: string }) =>
        graphqlPubSub.asyncIterator<ActivityEvent>(`activity:${args.marketId}`),
      resolve: (event: ActivityEvent) => ({
        type: event.type,
        marketId: event.marketId,
        timestamp:
          'timestamp' in event && typeof event.timestamp === 'string'
            ? event.timestamp
            : new Date().toISOString(),
        payload: JSON.stringify(event),
      }),
    },

    marketUpdated: {
      subscribe: (_: unknown, args: { marketId: string }) =>
        graphqlPubSub.asyncIterator(`${GRAPHQL_MARKET_UPDATED}:${args.marketId}`),
      resolve: async (event: ActivityEvent, _args: unknown, ctx: GraphQLContext) => {
        const market = await ctx.loaders.marketById.load(event.marketId);
        if (!market) {
          return mapMarket({
            id: 0,
            market_id: event.marketId,
            contract_address: '',
            match_id: '',
            fighter_a: '',
            fighter_b: '',
            weight_class: '',
            title_fight: false,
            venue: '',
            scheduled_at: new Date(),
            status: event.type === 'resolved' ? 'resolved' : 'open',
            outcome: null,
            pool_a: '0',
            pool_b: '0',
            pool_draw: '0',
            total_pool: '0',
            fee_bps: 0,
            lock_before_secs: 3600,
            resolved_at: null,
            oracle_used: null,
            created_at: new Date(),
            updated_at: new Date(),
            ledger_sequence: 0,
          });
        }
        // Clear loader cache so subscribers see fresh pools/status after activity.
        ctx.loaders.marketById.clear(event.marketId);
        const fresh = await ctx.loaders.marketById.load(event.marketId);
        return mapMarket(fresh ?? market);
      },
    },

    tradeCreated: {
      subscribe: (_: unknown, args: { marketId: string }) =>
        graphqlPubSub.asyncIterator(`${GRAPHQL_TRADE_CREATED}:${args.marketId}`),
      resolve: (event: ActivityEvent & { type: 'trade' }) => ({
        id: `trade:live:${event.timestamp}`,
        marketId: event.marketId,
        traderAddress: '',
        side: event.side === 'fighter_a' || event.side === 'fighter_b' || event.side === 'draw'
          ? event.side
          : 'fighter_a',
        amount: String(event.sharesAmount ?? 0),
        amountXlm: Number(event.sharesAmount ?? 0) / 10_000_000,
        priceBps: event.priceBps ?? null,
        executedAt: event.timestamp,
        txHash: '',
      }),
    },
  },
};
