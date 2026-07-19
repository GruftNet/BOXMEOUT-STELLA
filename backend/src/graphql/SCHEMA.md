# BoxMeOut GraphQL Schema

**Version:** `1.0.0`  
**Min compatible client version:** `1.0.0`  
**Endpoint:** `POST /graphql`  
**Subscriptions:** `ws://<host>/graphql` (graphql-ws protocol)

This document is the canonical reference for the market-data GraphQL API.
Query `schemaInfo` at runtime for the live version and deprecated field list.

## Design principles

- **Read model** for markets, bets, aggregated positions, trades, and wallet users
- **Backward compatible** additive evolution; snake_case aliases marked `@deprecated`
- **N+1 safe** via request-scoped DataLoaders
- **Abuse protected** via per-IP Express limits, per-user Redis limits, and query complexity/depth caps
- **Live data** via Redis `market:{id}:events` fan-out (target delivery &lt; 500ms)

## Root operations

### Query

| Field | Args | Returns | Notes |
|-------|------|---------|-------|
| `schemaInfo` | — | `SchemaInfo!` | Versioning / deprecation metadata |
| `market` | `id: ID!` | `Market` | `null` when missing |
| `markets` | `filter`, `sort`, `page`, `limit`, `first`, `after` | `MarketConnection!` | Any filter combination; offset or cursor pagination |
| `bets` | `marketId`, `bettorAddress`, `limit`, `offset` | `[Bet!]!` | |
| `positions` | `marketId`, `ownerAddress`, `limit`, `offset` | `[Position!]!` | Aggregated bets by owner+side |
| `trades` | `marketId`, `traderAddress`, `limit`, `offset` | `[Trade!]!` | Bet rows as trade fills |
| `user` | `address: ID!` | `User` | Address-centric projection |
| `portfolio` | `address: ID!` | `Portfolio!` | |
| `platformStats` | — | `PlatformStats!` | |

### Subscription

| Field | Args | Returns | Source |
|-------|------|---------|--------|
| `marketActivity` | `marketId` | `ActivityPayload!` | Redis activity bus |
| `marketUpdated` | `marketId` | `Market!` | Derived from activity events |
| `tradeCreated` | `marketId` | `Trade!` | `type: trade` events |

## Filters (`MarketFilterInput`)

All fields optional; combined with AND:

- `status` — `open \| locked \| resolved \| cancelled \| disputed`
- `weightClass` — exact match
- `fighter` — case-insensitive substring on fighter A/B
- `dateFrom` / `dateTo` — ISO-8601 on `scheduledAt`
- `titleFight` — boolean
- `venue` — case-insensitive substring
- `marketIds` — explicit allow-list

## Pagination

1. **Offset:** `page` + `limit` (default 1 / 50, max 100)
2. **Cursor:** `first` + `after` (Relay-style connection). Cursor encodes `scheduledAt|marketId`.

## Complexity limits

| Limit | Default |
|-------|---------|
| Max depth | 10 |
| Max complexity | 1000 |

List fields (`markets`, `bets`, `positions`, `trades`, `edges`, portfolio bet lists) multiply nested cost by 10.
Introspection is exempt.

Errors:

- `QUERY_DEPTH_EXCEEDED`
- `QUERY_COMPLEXITY_EXCEEDED`

## Rate limiting

| Layer | Key | Default |
|-------|-----|---------|
| Express middleware | IP | 60 req / 60s on `/graphql` |
| GraphQL executor | `x-user-id` or IP | 60 ops / 60s |

Over limit → HTTP `429` + GraphQL error `RATE_LIMITED` + `Retry-After`.

## Deprecated fields (removed in v2)

| Field | Replacement |
|-------|-------------|
| `Market.market_id` | `Market.marketId` |
| `MarketOdds.odds_a` | `MarketOdds.oddsA` |
| `MarketOdds.odds_b` | `MarketOdds.oddsB` |
| `MarketOdds.odds_draw` | `MarketOdds.oddsDraw` |

## Example queries

### Filtered markets

```graphql
query OpenHeavyweights {
  markets(
    filter: { status: open, weightClass: "heavyweight", fighter: "Ali" }
    sort: { field: SCHEDULED_AT, direction: ASC }
    first: 10
  ) {
    pageInfo { totalCount hasNextPage endCursor }
    edges {
      node {
        marketId
        fighterA
        fighterB
        odds { oddsA oddsB oddsDraw }
        positions { ownerAddress side totalAmountXlm }
      }
    }
  }
}
```

### Nested user portfolio (DataLoader-batched)

```graphql
query Portfolio($address: ID!) {
  user(address: $address) {
    address
    positions { marketId side totalAmountXlm market { fighterA fighterB status } }
    portfolio { totalStakedXlm pendingClaims { id amountXlm } }
  }
}
```

### Subscription

```graphql
subscription OnTrades($marketId: ID!) {
  tradeCreated(marketId: $marketId) {
    id
    side
    amountXlm
    priceBps
    executedAt
  }
}
```

## Out of scope

- REST → GraphQL migration
- Apollo Federation / supergraph
