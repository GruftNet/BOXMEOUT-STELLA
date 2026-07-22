// TTLs in seconds. Ranges reflect how volatile each data type is:
// balances/prices change every bet, metadata changes rarely, resolved markets never change.
export const CACHE_TTL = {
  USER_BALANCE: 8,
  MARKET_PRICE: 12,
  MARKET_METADATA: 600,
  OPEN_MARKETS_LIST: 45,
  LEADERBOARD: 90,
  MARKET_RESOLVED: 3600,
} as const;

export type CacheTtlKey = keyof typeof CACHE_TTL;
