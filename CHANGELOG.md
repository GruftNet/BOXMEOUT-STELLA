# Changelog

## [Unreleased]

### Added
- `Market::get_bet()` — view function returning a bettor's position (#716)
- `MarketFactory::get_open_market_ids()` — efficient open market filtering (#717)
- `Market::upgrade()` — admin-only WASM upgrade mechanism (#718)
- `create_market()` fee_bps override per market, capped at 1000 bps (#719)
- **LMSR AMM** — replaces static pool-ratio odds with Logarithmic Market Scoring Rule pricing (#16, #32)
  - `shared/math.rs`: integer-only `lmsr_exp` (Taylor series p=15, range reduction via n×ln2) and `lmsr_ln` (arctanh series p=15) with error-bound comments; no `f32`/`f64`
  - `shared/amm.rs`: `lmsr_cost` (marginal cost C(q+Δ)−C(q)), `lmsr_price` (e^(q_i/b)/Σe^(q_j/b)), log-sum-exp for numerical stability
  - `shared/types.rs`: `b: i128` liquidity parameter in `MarketConfig` (default 10,000 XLM, min 10 XLM); validated at `create_market` via `ContractError::InvalidConfig`
  - `market/lib.rs`: `bet.amount` stores LMSR marginal cost (not intended size) for correct proportional claims; per-bettor fee `fee_i = stake × total_fee / winning_pool` prevents overdraft
  - `backend/MarketService.ts`: `lmsrPriceBps`, `lmsrMarginalCost` helpers; `getMarketOdds`, `calculateOutcomeOdds`, `simulateProjectedPayout` all use LMSR math
  - `frontend/OddsDisplay.tsx`: consumes `odds_a/b/draw` in basis points from API; multiplier = (1−fee)/p_i
