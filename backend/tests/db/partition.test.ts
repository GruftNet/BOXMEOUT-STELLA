// ============================================================
// BOXMEOUT — Partition & Shard Strategy Unit Tests
// ============================================================

import type { Pool } from 'pg';
import {
  countDefaultPartitionRows,
  dropPartitionsOlderThan,
  ensureFuturePartitions,
  listPartitions,
  monthRange,
} from '../../src/db/partitionManager';
import { planRebalance, resolveShard, slotForKey, SLOT_COUNT, validateShardMap } from '../../src/db/shardMap';
import type { ShardDescriptor } from '../../src/db/shardMap';

const mockPool = () => ({ query: jest.fn() }) as unknown as Pool & { query: jest.Mock };

const shard = (overrides: Partial<ShardDescriptor> & Pick<ShardDescriptor, 'shardKey' | 'slotStart' | 'slotEnd'>) =>
  ({
    dsnEnvVar: 'DATABASE_URL',
    status: 'active',
    healthy: true,
    lastHealthCheckAt: null,
    ...overrides,
  }) as ShardDescriptor;

describe('partitionManager', () => {
  describe('monthRange', () => {
    it('derives a half-open UTC month from any day within it', () => {
      const range = monthRange('bets', new Date('2026-07-20T13:45:00Z'));

      expect(range.name).toBe('bets_2026_07');
      expect(range.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('rolls the upper bound into the next year in December', () => {
      const range = monthRange('blockchain_events', new Date('2026-12-31T23:59:59Z'));

      expect(range.name).toBe('blockchain_events_2026_12');
      expect(range.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('pads single-digit months so names sort chronologically', () => {
      expect(monthRange('bets', new Date('2026-03-05T00:00:00Z')).name).toBe('bets_2026_03');
    });
  });

  describe('ensureFuturePartitions', () => {
    it('creates only the months that do not already exist', async () => {
      const pool = mockPool();
      // First month exists, the rest do not.
      pool.query
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [] });

      const created = await ensureFuturePartitions(pool, 'bets', 2);

      expect(created).toHaveLength(2);
      const createStatements = pool.query.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('PARTITION OF bets'),
      );
      expect(createStatements).toHaveLength(2);
    });

    it('passes ISO bounds as parameters rather than interpolating them', async () => {
      const pool = mockPool();
      pool.query.mockResolvedValueOnce({ rows: [{ exists: false }] }).mockResolvedValueOnce({ rows: [] });

      await ensureFuturePartitions(pool, 'bets', 0);

      const [, values] = pool.query.mock.calls[1];
      expect(values).toHaveLength(2);
      expect(values[0]).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    });
  });

  describe('dropPartitionsOlderThan', () => {
    it('drops partitions past the window and leaves recent ones attached', async () => {
      const pool = mockPool();
      const now = new Date();
      const old = monthRange('bets', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)));
      const recent = monthRange('bets', now);

      pool.query.mockImplementation((text: string) => {
        if (text.includes('pg_inherits')) {
          return Promise.resolve({ rows: [{ child: old.name }, { child: recent.name }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const dropped = await dropPartitionsOlderThan(pool, 'bets', 6);

      expect(dropped).toEqual([old.name]);
    });

    it('never drops the default partition', async () => {
      const pool = mockPool();
      pool.query.mockImplementation((text: string) => {
        if (text.includes('pg_inherits')) {
          return Promise.resolve({ rows: [{ child: 'bets_default' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const dropped = await dropPartitionsOlderThan(pool, 'bets', 1);

      expect(dropped).toEqual([]);
      expect(pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes('DROP TABLE'))).toBe(false);
    });

    it('detaches before dropping so an interrupted drop leaves data readable', async () => {
      const pool = mockPool();
      const old = monthRange('bets', new Date(Date.UTC(2020, 0, 1)));

      pool.query.mockImplementation((text: string) => {
        if (text.includes('pg_inherits')) return Promise.resolve({ rows: [{ child: old.name }] });
        return Promise.resolve({ rows: [] });
      });

      await dropPartitionsOlderThan(pool, 'bets', 6);

      const statements = pool.query.mock.calls.map((c: unknown[]) => String(c[0]));
      const detachAt = statements.findIndex((s) => s.includes('DETACH PARTITION'));
      const dropAt = statements.findIndex((s) => s.includes('DROP TABLE'));
      expect(detachAt).toBeGreaterThan(-1);
      expect(dropAt).toBeGreaterThan(detachAt);
    });
  });

  describe('listPartitions / countDefaultPartitionRows', () => {
    it('returns child table names', async () => {
      const pool = mockPool();
      pool.query.mockResolvedValue({ rows: [{ child: 'bets_2026_07' }, { child: 'bets_default' }] });

      expect(await listPartitions(pool, 'bets')).toEqual(['bets_2026_07', 'bets_default']);
    });

    it('reports default-partition rows as a number', async () => {
      const pool = mockPool();
      pool.query.mockResolvedValue({ rows: [{ count: '42' }] });

      expect(await countDefaultPartitionRows(pool, 'bets')).toBe(42);
    });

    it('reports zero when the default partition is empty', async () => {
      const pool = mockPool();
      pool.query.mockResolvedValue({ rows: [{ count: '0' }] });

      expect(await countDefaultPartitionRows(pool, 'blockchain_events')).toBe(0);
    });
  });
});

describe('shardMap', () => {
  describe('slotForKey', () => {
    it('is deterministic', () => {
      expect(slotForKey('market-abc')).toBe(slotForKey('market-abc'));
    });

    it('always lands inside the slot space', () => {
      for (let i = 0; i < 500; i += 1) {
        const slot = slotForKey(`market-${i}`);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(SLOT_COUNT);
      }
    });

    it('spreads keys across the space rather than clustering', () => {
      const slots = new Set(Array.from({ length: 200 }, (_, i) => slotForKey(`market-${i}`)));
      expect(slots.size).toBeGreaterThan(150);
    });
  });

  describe('validateShardMap', () => {
    it('accepts full contiguous coverage', () => {
      expect(() =>
        validateShardMap([
          shard({ shardKey: 'a', slotStart: 0, slotEnd: 2048 }),
          shard({ shardKey: 'b', slotStart: 2048, slotEnd: SLOT_COUNT }),
        ]),
      ).not.toThrow();
    });

    it('accepts the single-shard default', () => {
      expect(() => validateShardMap([shard({ shardKey: 'shard-0', slotStart: 0, slotEnd: SLOT_COUNT })])).not.toThrow();
    });

    it('rejects a gap that would silently drop writes', () => {
      expect(() =>
        validateShardMap([
          shard({ shardKey: 'a', slotStart: 0, slotEnd: 1000 }),
          shard({ shardKey: 'b', slotStart: 2000, slotEnd: SLOT_COUNT }),
        ]),
      ).toThrow(/not contiguous/);
    });

    it('rejects an overlap that would route one key to two shards', () => {
      expect(() =>
        validateShardMap([
          shard({ shardKey: 'a', slotStart: 0, slotEnd: 3000 }),
          shard({ shardKey: 'b', slotStart: 2000, slotEnd: SLOT_COUNT }),
        ]),
      ).toThrow(/not contiguous/);
    });

    it('rejects a map that stops short of the full space', () => {
      expect(() => validateShardMap([shard({ shardKey: 'a', slotStart: 0, slotEnd: 100 })])).toThrow(/covers 100 of/);
    });
  });

  describe('resolveShard', () => {
    it('routes a key to the shard owning its slot', () => {
      const shards = [
        shard({ shardKey: 'a', slotStart: 0, slotEnd: 2048 }),
        shard({ shardKey: 'b', slotStart: 2048, slotEnd: SLOT_COUNT }),
      ];
      const key = 'market-abc';
      const expected = slotForKey(key) < 2048 ? 'a' : 'b';

      expect(resolveShard(shards, key).shardKey).toBe(expected);
    });

    it('sends every key to the sole shard in a single-shard deployment', () => {
      const shards = [shard({ shardKey: 'shard-0', slotStart: 0, slotEnd: SLOT_COUNT })];

      for (let i = 0; i < 50; i += 1) {
        expect(resolveShard(shards, `market-${i}`).shardKey).toBe('shard-0');
      }
    });

    it('throws rather than guessing when the map has a hole', () => {
      const shards = [shard({ shardKey: 'a', slotStart: 0, slotEnd: 1 })];
      // slotForKey is deterministic, so pick a key that misses slot 0.
      const key = Array.from({ length: 100 }, (_, i) => `market-${i}`).find((k) => slotForKey(k) !== 0);

      expect(() => resolveShard(shards, key as string)).toThrow(/no shard owns slot/);
    });
  });

  describe('planRebalance', () => {
    it('proposes nothing for a single shard', () => {
      expect(planRebalance([shard({ shardKey: 'shard-0', slotStart: 0, slotEnd: SLOT_COUNT })])).toEqual([]);
    });

    it('proposes nothing when ownership is already even', () => {
      expect(
        planRebalance([
          shard({ shardKey: 'a', slotStart: 0, slotEnd: 2048 }),
          shard({ shardKey: 'b', slotStart: 2048, slotEnd: SLOT_COUNT }),
        ]),
      ).toEqual([]);
    });

    it('moves slots from the overloaded shard to the new empty one', () => {
      const moves = planRebalance([
        shard({ shardKey: 'a', slotStart: 0, slotEnd: SLOT_COUNT }),
        shard({ shardKey: 'b', slotStart: SLOT_COUNT, slotEnd: SLOT_COUNT }),
      ]);

      expect(moves).toEqual([{ from: 'a', to: 'b', slots: 2048 }]);
    });

    it('ignores shards that are not active', () => {
      const moves = planRebalance([
        shard({ shardKey: 'a', slotStart: 0, slotEnd: SLOT_COUNT }),
        shard({ shardKey: 'b', slotStart: SLOT_COUNT, slotEnd: SLOT_COUNT, status: 'offline' }),
      ]);

      expect(moves).toEqual([]);
    });
  });
});
