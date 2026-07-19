/** Current GraphQL schema version. Bump minor for additive changes, major for breaking. */
export const SCHEMA_VERSION = '1.0.0';

/** Oldest client schema version still supported without forced upgrade. */
export const MIN_COMPATIBLE_VERSION = '1.0.0';

/** Fields retained for backward compatibility; removed in the next major. */
export const DEPRECATED_FIELDS = [
  'Market.market_id',
  'MarketOdds.odds_a',
  'MarketOdds.odds_b',
  'MarketOdds.odds_draw',
] as const;
