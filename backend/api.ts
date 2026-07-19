/**
 * @file api.ts
 * @description Backend API for prediction market
 *
 * GraphQL query engine: `src/graphql/`
 * - Schema + docs: `src/graphql/typeDefs.ts`, `src/graphql/SCHEMA.md`
 * - DataLoaders: `src/graphql/dataloaders.ts`
 * - Complexity / rate limits: `src/graphql/complexity.ts`, `src/graphql/rateLimit.ts`
 * - Subscriptions (Redis): `src/graphql/pubsub.ts`
 * - Mount helper: `mountGraphQL` from `src/graphql`
 *
 * Wired from `src/index.ts` at `POST /graphql` (subscriptions on `ws:///graphql`).
 */

/**
 * Initialize and manage prediction market API endpoints.
 * Prefer `mountGraphQL(app, server)` from `./src/graphql` (used by `src/index.ts`).
 */
export function initializePredictionMarketAPI(): void {
  // GraphQL is mounted in src/index.ts via mountGraphQL().
}
