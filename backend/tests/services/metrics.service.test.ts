import {
  cacheRegistry,
  recordCacheHit,
  recordCacheMiss,
  recordCacheError,
  setL1CacheSize,
} from '../../src/services/metrics.service';

describe('Cache Metrics', () => {
  beforeEach(async () => {
    cacheRegistry.resetMetrics();
  });

  it('increments cache_hits_total labeled by namespace and layer', async () => {
    recordCacheHit('market', 'l1');
    recordCacheHit('market', 'l2');

    const metric = await cacheRegistry.getSingleMetric('cache_hits_total')?.get();
    const total = metric?.values.reduce((sum, v) => sum + v.value, 0);
    expect(total).toBe(2);
  });

  it('increments cache_misses_total labeled by namespace', async () => {
    recordCacheMiss('balance');

    const metric = await cacheRegistry.getSingleMetric('cache_misses_total')?.get();
    expect(metric?.values[0].value).toBe(1);
    expect(metric?.values[0].labels.namespace).toBe('balance');
  });

  it('increments cache_errors_total labeled by namespace and operation', async () => {
    recordCacheError('price', 'get');

    const metric = await cacheRegistry.getSingleMetric('cache_errors_total')?.get();
    expect(metric?.values[0].value).toBe(1);
    expect(metric?.values[0].labels.operation).toBe('get');
  });

  it('sets the L1 cache size gauge', async () => {
    setL1CacheSize(42);

    const metric = await cacheRegistry.getSingleMetric('cache_l1_size')?.get();
    expect(metric?.values[0].value).toBe(42);
  });
});
