import { memGet, memSet, memDel, memDeletePattern, memClear, memSize } from '../../src/services/memory-cache';

describe('Memory Cache (L1)', () => {
  beforeEach(() => {
    memClear();
  });

  it('returns null for a missing key', () => {
    expect(memGet('missing')).toBeNull();
  });

  it('stores and retrieves a value within its TTL', () => {
    memSet('market:1', { status: 'open' }, 60);
    expect(memGet('market:1')).toEqual({ status: 'open' });
  });

  it('expires a value after its TTL elapses', () => {
    const now = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    memSet('market:1', { status: 'open' }, 5);

    jest.spyOn(Date, 'now').mockReturnValue(now + 5_001);
    expect(memGet('market:1')).toBeNull();

    jest.restoreAllMocks();
  });

  it('deletes a single key', () => {
    memSet('market:1', 'a', 60);
    memDel('market:1');
    expect(memGet('market:1')).toBeNull();
  });

  it('deletes keys matching a glob pattern', () => {
    memSet('market:1', 'a', 60);
    memSet('market:2', 'b', 60);
    memSet('leaderboard:global', 'c', 60);

    memDeletePattern('market:*');

    expect(memGet('market:1')).toBeNull();
    expect(memGet('market:2')).toBeNull();
    expect(memGet('leaderboard:global')).toBe('c');
  });

  it('reports the current size', () => {
    memSet('a', 1, 60);
    memSet('b', 2, 60);
    expect(memSize()).toBe(2);
  });

  it('clears all entries', () => {
    memSet('a', 1, 60);
    memSet('b', 2, 60);
    memClear();
    expect(memSize()).toBe(0);
  });
});
