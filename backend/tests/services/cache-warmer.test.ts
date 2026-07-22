import { warmCache } from '../../src/services/cache-warmer';
import * as cacheService from '../../src/services/cache.service';

jest.mock('../../src/services/cache.service', () => ({
  set: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));

describe('Cache Warmer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (cacheService.set as jest.Mock).mockResolvedValue(undefined);
  });

  it('warms the open markets list and each market entry', async () => {
    const markets = [
      { marketId: 'm1', metadata: { fighterA: 'A' } },
      { marketId: 'm2', metadata: { fighterA: 'B' } },
    ];
    const loadOpenMarkets = jest.fn().mockResolvedValue(markets);

    const count = await warmCache({ loadOpenMarkets });

    expect(count).toBe(2);
    expect(cacheService.set).toHaveBeenCalledWith('markets:open:list', ['m1', 'm2'], expect.any(Number));
    expect(cacheService.set).toHaveBeenCalledWith('market:m1', { fighterA: 'A' }, expect.any(Number));
    expect(cacheService.set).toHaveBeenCalledWith('market:m2', { fighterA: 'B' }, expect.any(Number));
  });

  it('returns 0 and does not throw when the loader fails', async () => {
    const loadOpenMarkets = jest.fn().mockRejectedValue(new Error('db down'));

    const count = await warmCache({ loadOpenMarkets });

    expect(count).toBe(0);
  });

  it('handles an empty open markets list', async () => {
    const loadOpenMarkets = jest.fn().mockResolvedValue([]);

    const count = await warmCache({ loadOpenMarkets });

    expect(count).toBe(0);
    expect(cacheService.set).toHaveBeenCalledWith('markets:open:list', [], expect.any(Number));
  });
});
