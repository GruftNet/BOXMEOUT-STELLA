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

function makeMarket(id: string, n: number): Market {
  return {
    id: n,
    market_id: id,
    contract_address: 'C...',
    match_id: `fight-${n}`,
    fighter_a: 'A',
    fighter_b: 'B',
    weight_class: 'heavyweight',
    title_fight: false,
    venue: 'Arena',
    scheduled_at: new Date(`2026-0${n}-01T00:00:00Z`),
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
    created_at: new Date(),
    updated_at: new Date(),
    ledger_sequence: 1000 + n,
  };
}

describe('GraphQL DataLoader N+1 prevention', () => {
  it('batches betsByMarket loads across nested market fields', async () => {
    const markets = [makeMarket('mkt-1', 1), makeMarket('mkt-2', 2), makeMarket('mkt-3', 3)];
    const findBetsByMarket = jest.fn().mockImplementation(async (marketId: string) => {
      const bet: Bet = {
        id: Number(marketId.replace(/\D/g, '')) || 1,
        market_id: marketId,
        bettor_address: 'GABC',
        side: 'fighter_a',
        amount: '10000000',
        amount_xlm: 1,
        placed_at: new Date(),
        claimed: false,
        claimed_at: null,
        payout: null,
        tx_hash: 'tx',
        ledger_sequence: 1,
      };
      return [bet];
    });

    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue(markets),
      findMarketById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(markets.find((m) => m.market_id === id) ?? null),
      ),
      findBetsByAddress: jest.fn().mockResolvedValue([]),
      findBetsByMarket,
      updateMarketStatus: jest.fn(),
    });

    const result = await executeGraphQL({
      schema,
      query: `
        query {
          m1: market(id: "mkt-1") { bets { id } positions { id } trades { id } }
          m2: market(id: "mkt-2") { bets { id } positions { id } trades { id } }
          m3: market(id: "mkt-3") { bets { id } positions { id } trades { id } }
        }
      `,
      skipRateLimit: true,
      context: { loaders: createLoaders(), userId: null, clientIp: '127.0.0.1', identity: 'test' },
    });

    expect(result.errors).toBeUndefined();
    // One batched load per market id (cached for bets/positions/trades on same parent)
    expect(findBetsByMarket.mock.calls.length).toBe(3);
    expect(findBetsByMarket.mock.calls.map((c) => c[0]).sort()).toEqual([
      'mkt-1',
      'mkt-2',
      'mkt-3',
    ]);
  });
});
