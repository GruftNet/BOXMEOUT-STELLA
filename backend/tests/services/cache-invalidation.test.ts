import * as invalidation from '../../src/services/cache-invalidation';
import * as multiLevel from '../../src/services/multi-level-cache';

jest.mock('../../src/services/multi-level-cache', () => ({
  invalidate: jest.fn(),
  invalidatePattern: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));

describe('Cache Invalidation Events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onBetPlaced invalidates price, market and balance keys', async () => {
    await invalidation.onBetPlaced('market-1', 'GABC123');

    expect(multiLevel.invalidate).toHaveBeenCalledWith('price:market-1');
    expect(multiLevel.invalidate).toHaveBeenCalledWith('market:market-1');
    expect(multiLevel.invalidate).toHaveBeenCalledWith('balance:GABC123');
  });

  it('onMarketResolved invalidates market, price and leaderboard keys', async () => {
    await invalidation.onMarketResolved('market-1');

    expect(multiLevel.invalidate).toHaveBeenCalledWith('market:market-1');
    expect(multiLevel.invalidate).toHaveBeenCalledWith('price:market-1');
    expect(multiLevel.invalidatePattern).toHaveBeenCalledWith('leaderboard:*');
  });

  it('onMarketCreated invalidates the open markets list', async () => {
    await invalidation.onMarketCreated();
    expect(multiLevel.invalidatePattern).toHaveBeenCalledWith('markets:open:list*');
  });

  it('onMarketLocked invalidates the open markets list and the market entry', async () => {
    await invalidation.onMarketLocked('market-2');

    expect(multiLevel.invalidatePattern).toHaveBeenCalledWith('markets:open:list*');
    expect(multiLevel.invalidate).toHaveBeenCalledWith('market:market-2');
  });

  it('onDisputeResolved invalidates the market entry', async () => {
    await invalidation.onDisputeResolved('market-3');
    expect(multiLevel.invalidate).toHaveBeenCalledWith('market:market-3');
  });
});
