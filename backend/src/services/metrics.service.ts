import { Counter, Gauge, Registry } from 'prom-client';

export const cacheRegistry = new Registry();

export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['namespace', 'layer'] as const,
  registers: [cacheRegistry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['namespace'] as const,
  registers: [cacheRegistry],
});

export const cacheErrorsTotal = new Counter({
  name: 'cache_errors_total',
  help: 'Total cache errors',
  labelNames: ['namespace', 'operation'] as const,
  registers: [cacheRegistry],
});

export const l1CacheSize = new Gauge({
  name: 'cache_l1_size',
  help: 'Number of entries currently held in the in-process L1 cache',
  registers: [cacheRegistry],
});

export function recordCacheHit(namespace: string, layer: 'l1' | 'l2'): void {
  cacheHitsTotal.inc({ namespace, layer });
}

export function recordCacheMiss(namespace: string): void {
  cacheMissesTotal.inc({ namespace });
}

export function recordCacheError(namespace: string, operation: string): void {
  cacheErrorsTotal.inc({ namespace, operation });
}

export function setL1CacheSize(size: number): void {
  l1CacheSize.set(size);
}
