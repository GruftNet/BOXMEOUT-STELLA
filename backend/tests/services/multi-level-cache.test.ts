import * as multiLevel from '../../src/services/multi-level-cache';
import * as cacheService from '../../src/services/cache.service';
import { memClear, memGet } from '../../src/services/memory-cache';

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  delPattern: jest.fn(),
  flushAll: jest.fn(),
}));

describe('Multi-Level Cache (L1 + L2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memClear();
  });

  describe('get', () => {
    it('returns the L1 value without touching L2 when present', async () => {
      const seeded = { id: '1' };
      await multiLevel.set('market:1', seeded, 60);
      (cacheService.get as jest.Mock).mockClear();

      const result = await multiLevel.get('market:1');

      expect(result).toEqual(seeded);
      expect(cacheService.get).not.toHaveBeenCalled();
    });

    it('falls back to L2 on an L1 miss and repopulates L1', async () => {
      const value = { id: '2' };
      (cacheService.get as jest.Mock).mockResolvedValue(value);

      const result = await multiLevel.get('market:2');

      expect(result).toEqual(value);
      expect(cacheService.get).toHaveBeenCalledWith('market:2');
      expect(memGet('market:2')).toEqual(value);
    });

    it('returns null when both L1 and L2 miss', async () => {
      (cacheService.get as jest.Mock).mockResolvedValue(null);
      const result = await multiLevel.get('market:missing');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('writes through to both L1 and L2', async () => {
      await multiLevel.set('market:3', { id: '3' }, 60);
      expect(memGet('market:3')).toEqual({ id: '3' });
      expect(cacheService.set).toHaveBeenCalledWith('market:3', { id: '3' }, 60);
    });
  });

  describe('invalidate', () => {
    it('clears the key from both L1 and L2', async () => {
      await multiLevel.set('market:4', { id: '4' }, 60);
      await multiLevel.invalidate('market:4');

      expect(memGet('market:4')).toBeNull();
      expect(cacheService.del).toHaveBeenCalledWith('market:4');
    });
  });

  describe('invalidatePattern', () => {
    it('clears matching keys from L1 and delegates the pattern to L2', async () => {
      await multiLevel.set('market:5', { id: '5' }, 60);
      await multiLevel.invalidatePattern('market:*');

      expect(memGet('market:5')).toBeNull();
      expect(cacheService.delPattern).toHaveBeenCalledWith('market:*');
    });
  });

  describe('getOrSet', () => {
    it('computes and populates both layers on a full miss', async () => {
      (cacheService.get as jest.Mock).mockResolvedValue(null);
      const compute = jest.fn().mockResolvedValue({ id: '6' });

      const result = await multiLevel.getOrSet('market:6', 60, compute);

      expect(result).toEqual({ id: '6' });
      expect(compute).toHaveBeenCalledTimes(1);
      expect(memGet('market:6')).toEqual({ id: '6' });
      expect(cacheService.set).toHaveBeenCalledWith('market:6', { id: '6' }, 60);
    });

    it('skips compute when L1 already has the value', async () => {
      await multiLevel.set('market:7', { id: '7' }, 60);
      const compute = jest.fn();

      const result = await multiLevel.getOrSet('market:7', 60, compute);

      expect(result).toEqual({ id: '7' });
      expect(compute).not.toHaveBeenCalled();
    });
  });

  describe('flushAll', () => {
    it('clears L1 and delegates to L2 flush', async () => {
      await multiLevel.set('market:8', { id: '8' }, 60);
      await multiLevel.flushAll();

      expect(memGet('market:8')).toBeNull();
      expect(cacheService.flushAll).toHaveBeenCalledTimes(1);
    });
  });
});
