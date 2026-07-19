/**
 * GraphQL SDL for market data queries and live subscriptions.
 * Schema version: 1.0.0 — see SCHEMA.md for field docs and deprecations.
 */

export const typeDefs = /* GraphQL */ `
  enum MarketStatus {
    open
    locked
    resolved
    cancelled
    disputed
  }

  enum Outcome {
    fighter_a
    fighter_b
    draw
    no_contest
  }

  enum BetSide {
    fighter_a
    fighter_b
    draw
  }

  enum TradeSide {
    fighter_a
    fighter_b
    draw
  }

  enum MarketSortField {
    SCHEDULED_AT
    TOTAL_POOL
    CREATED_AT
  }

  enum SortDirection {
    ASC
    DESC
  }

  type MarketOdds {
    oddsA: Int!
    oddsB: Int!
    oddsDraw: Int!
    odds_a: Int! @deprecated(reason: "Use oddsA — snake_case fields removed in schema v2")
    odds_b: Int! @deprecated(reason: "Use oddsB — snake_case fields removed in schema v2")
    odds_draw: Int! @deprecated(reason: "Use oddsDraw — snake_case fields removed in schema v2")
  }

  type Market {
    id: ID!
    marketId: ID!
    contractAddress: String!
    matchId: String!
    fighterA: String!
    fighterB: String!
    weightClass: String!
    titleFight: Boolean!
    venue: String!
    scheduledAt: String!
    status: MarketStatus!
    outcome: Outcome
    poolA: String!
    poolB: String!
    poolDraw: String!
    totalPool: String!
    feeBps: Int!
    lockBeforeSecs: Int!
    resolvedAt: String
    oracleUsed: String
    createdAt: String!
    updatedAt: String!
    ledgerSequence: Int!
    odds: MarketOdds!
    stats: MarketStats
    bets(limit: Int = 50, offset: Int = 0, bettorAddress: String): [Bet!]!
    positions(limit: Int = 50, offset: Int = 0): [Position!]!
    trades(limit: Int = 50, offset: Int = 0): [Trade!]!
    market_id: ID! @deprecated(reason: "Use marketId — snake_case fields removed in schema v2")
  }

  type MarketStats {
    marketId: ID!
    totalBets: Int!
    uniqueBettors: Int!
    largestBetXlm: Float!
    averageBetXlm: Float!
    totalPooledXlm: Float!
  }

  type Bet {
    id: ID!
    marketId: ID!
    bettorAddress: String!
    side: BetSide!
    amount: String!
    amountXlm: Float!
    placedAt: String!
    claimed: Boolean!
    claimedAt: String
    payout: String
    txHash: String!
    ledgerSequence: Int!
    market: Market
    user: User
  }

  """Aggregated stake for a bettor on one market side (position view)."""
  type Position {
    id: ID!
    marketId: ID!
    ownerAddress: String!
    side: BetSide!
    totalAmount: String!
    totalAmountXlm: Float!
    betCount: Int!
    market: Market
    user: User
  }

  """Individual fill / bet as a trade in the activity stream."""
  type Trade {
    id: ID!
    marketId: ID!
    traderAddress: String!
    side: TradeSide!
    amount: String!
    amountXlm: Float!
    priceBps: Int
    executedAt: String!
    txHash: String!
    market: Market
    user: User
  }

  """Wallet-centric user projection (no separate users table)."""
  type User {
    address: ID!
    bets(limit: Int = 50, offset: Int = 0): [Bet!]!
    positions(limit: Int = 50, offset: Int = 0): [Position!]!
    trades(limit: Int = 50, offset: Int = 0): [Trade!]!
    portfolio: Portfolio!
  }

  type Portfolio {
    address: ID!
    activeBets: [Bet!]!
    pastBets: [Bet!]!
    pendingClaims: [Bet!]!
    totalStakedXlm: Float!
    totalWonXlm: Float!
    totalLostXlm: Float!
  }

  type PlatformStats {
    totalMarkets: Int!
    activeMarkets: Int!
    totalVolume: Float!
    totalBets: Int!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    totalCount: Int!
  }

  type MarketEdge {
    cursor: String!
    node: Market!
  }

  type MarketConnection {
    edges: [MarketEdge!]!
    pageInfo: PageInfo!
  }

  type SchemaInfo {
    version: String!
    minCompatibleVersion: String!
    deprecatedFields: [String!]!
  }

  input MarketFilterInput {
    status: MarketStatus
    weightClass: String
    fighter: String
    dateFrom: String
    dateTo: String
    titleFight: Boolean
    venue: String
    marketIds: [ID!]
  }

  input MarketSortInput {
    field: MarketSortField = SCHEDULED_AT
    direction: SortDirection = DESC
  }

  type ActivityPayload {
    type: String!
    marketId: ID!
    timestamp: String!
    payload: String!
  }

  type Query {
    """Schema versioning metadata for backward-compatible clients."""
    schemaInfo: SchemaInfo!

    market(id: ID!): Market

    """
    List markets with any combination of filters, sorting, and
    either offset pagination (page/limit) or cursor pagination (first/after).
    """
    markets(
      filter: MarketFilterInput
      sort: MarketSortInput
      page: Int = 1
      limit: Int = 50
      first: Int
      after: String
    ): MarketConnection!

    bets(marketId: ID, bettorAddress: String, limit: Int = 50, offset: Int = 0): [Bet!]!
    positions(marketId: ID, ownerAddress: String, limit: Int = 50, offset: Int = 0): [Position!]!
    trades(marketId: ID, traderAddress: String, limit: Int = 50, offset: Int = 0): [Trade!]!
    user(address: ID!): User
    portfolio(address: ID!): Portfolio!
    platformStats: PlatformStats!
  }

  type Subscription {
    """Live activity for a market (trades, disputes, resolutions). Target latency < 500ms."""
    marketActivity(marketId: ID!): ActivityPayload!

    """Emitted when a market row-relevant field changes (status, pools, outcome)."""
    marketUpdated(marketId: ID!): Market!

    """Emitted for each new trade on a market."""
    tradeCreated(marketId: ID!): Trade!
  }
`;
