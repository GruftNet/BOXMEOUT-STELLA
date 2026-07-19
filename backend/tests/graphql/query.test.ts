import { setDbAdapter } from '../../src/services/MarketService';
import type { Market } from '../../src/models/Market';
import type { Bet } from '../../src/models/Bet';
import { executeGraphQL } from '../../src/graphql/execute';
import { schema } from '../../src/graphql/schema';
import { createLoaders } from '../../src/graphql/dataloaders';

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(60),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../../src/services/StellarService', () => ({
  readContractState: jest.fn(),
  submitTransaction: jest.fn(),
}));

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: 1,
    market_id: 'mkt-1',
    contract_address: 'C...',
    match_id: 'fight-1',
    fighter_a: 'Ali',
    fighter_b: 'Frazier',
    weight_class: 'heavyweight',
    title_fight: true,
    venue: 'MSG',
    scheduled_at: new Date('2026-06-01T00:00:00Z'),
    status: 'open',
    outcome: null,
    pool_a: '0',
    pool_b: '0',
    pool_draw: '0',
    total_pool: '0',
    fee_bps: 200,
    lock_before_secs: 3600,
    resolved_at: null,
    oracle_used: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date(),
    ledger_sequence: 1000,
    ...overrides,
  };
}

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: 1,
    market_id: 'mkt-1',
    bettor_address: 'GABC',
    side: 'fighter_a',
    amount: '10000000',
    amount_xlm: 1,
    placed_at: new Date('2026-05-01T00:00:00Z'),
    claimed: false,
    claimed_at: null,
    payout: null,
    tx_hash: 'tx1',
    ledger_sequence: 1001,
    ...overrides,
  };
}

const OPEN = makeMarket({ market_id: 'mkt-1', status: 'open' });
const LOCKED = makeMarket({
  id: 2,
  market_id: 'mkt-2',
  status: 'locked',
  weight_class: 'welterweight',
  fighter_a: 'Leonard',
  fighter_b: 'Hearns',
  title_fight: false,
  scheduled_at: new Date('2026-07-01T00:00:00Z'),
});

describe('GraphQL market queries', () => {
  beforeEach(() => {
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([OPEN, LOCKED]),
      findMarketById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve([OPEN, LOCKED].find((m) => m.market_id === id) ?? null),
      ),
      findBetsByAddress: jest.fn().mockResolvedValue([makeBet()]),
      findBetsByMarket: jest.fn().mockImplementation((marketId: string) =>
        Promise.resolve(
          [makeBet(), makeBet({ id: 2, bettor_address: 'GDEF', side: 'fighter_b' })].filter(
            (b) => b.market_id === marketId,
          ),
        ),
      ),
      updateMarketStatus: jest.fn(),
    });
  });

  it('queries markets with combined filters', async () => {
    const result = await executeGraphQL({
      schema,
      query: `
        query {
          markets(filter: { status: open, weightClass: "heavyweight", fighter: "Ali", titleFight: true }) {
            pageInfo { totalCount }
            edges { node { marketId fighterA status titleFight } }
          }
        }
      `,
      skipRateLimit: true,
      context: { loaders: createLoaders(), userId: null, clientIp: '127.0.0.1', identity: 'test' },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as {
      markets: { pageInfo: { totalCount: number }; edges: { node: { marketId: string } }[] };
    };
    expect(data.markets.pageInfo.totalCount).toBe(1);
    expect(data.markets.edges[0].node.marketId).toBe('mkt-1');
  });

  it('resolves nested market → bets → user without errors', async () => {
    const result = await executeGraphQL({
      schema,
      query: `
        query {
          market(id: "mkt-1") {
            marketId
            odds { oddsA odds_a }
            bets { id bettorAddress user { address } }
            positions { id side betCount }
          }
        }
      `,
      skipRateLimit: true,
      context: { loaders: createLoaders(), userId: null, clientIp: '127.0.0.1', identity: 'test' },
    });

    expect(result.errors).toBeUndefined();
    const market = (result.data as { market: { bets: unknown[]; positions: unknown[]; odds: { oddsA: number; odds_a: number } } }).market;
    expect(market.bets).toHaveLength(2);
    expect(market.positions.length).toBeGreaterThan(0);
    expect(market.odds.oddsA).toBe(market.odds.odds_a);
  });

  it('returns schema versioning metadata', async () => {
    const result = await executeGraphQL({
      schema,
      query: `{ schemaInfo { version minCompatibleVersion deprecatedFields } }`,
      skipRateLimit: true,
      context: { loaders: createLoaders(), userId: null, clientIp: '127.0.0.1', identity: 'test' },
    });

    expect(result.errors).toBeUndefined();
    const info = (result.data as { schemaInfo: { version: string; deprecatedFields: string[] } }).schemaInfo;
    expect(info.version).toBe('1.0.0');
    expect(info.deprecatedFields).toContain('Market.market_id');
  });
});
