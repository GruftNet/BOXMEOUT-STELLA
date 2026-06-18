//! ============================================================
//! BOXMEOUT — AMM Math Module
//! LMSR Automated Market Maker with fixed-point arithmetic.
//! No f32/f64 — all arithmetic is integer-only for Soroban WASM.
//! ============================================================

use crate::errors::ContractError;
use crate::math::{lmsr_exp, lmsr_ln, LMSR_SCALE};
use crate::types::BetSide;

// ─── Minimum b (10 XLM in stroops) ───────────────────────────────────────────

/// Minimum allowed liquidity parameter b (10 XLM = 100_000_000 stroops).
pub const LMSR_B_MIN: i128 = 100_000_000;

/// Default liquidity parameter b (1000 XLM = 10_000_000_000 stroops).
pub const LMSR_B_DEFAULT: i128 = 10_000_000_000;

// ─── LMSR cost function ───────────────────────────────────────────────────────

/// Computes the LMSR marginal cost of placing a bet of `delta` stroops on `side`.
///
/// # Formula
/// C(q) = b · ln(e^{q_a/b} + e^{q_b/b} + e^{q_draw/b})
/// cost  = C(q + Δ_side) − C(q)
///
/// The log-sum-exp trick avoids overflow:
///   ln(Σ e^{x_i}) = max(x) + ln(Σ e^{x_i − max(x)})
/// All shifted exponents ≤ 0, so each lmsr_exp call operates on a ≤ 0 argument.
///
/// # Arguments
/// * `q_a`, `q_b`, `q_draw` — current pool quantities in stroops
/// * `delta`                 — bet size in stroops (must be > 0)
/// * `side`                  — which outcome receives the bet
/// * `b`                     — LMSR liquidity parameter in stroops (must be ≥ LMSR_B_MIN)
///
/// # Returns
/// Marginal cost in stroops, always strictly positive for delta > 0.
///
/// # Errors
/// * `InvalidConfig`      — b < LMSR_B_MIN
/// * `ArithmeticOverflow` — intermediate overflow (q_i/b too large for fixed-point)
pub fn lmsr_cost(
    q_a: i128,
    q_b: i128,
    q_draw: i128,
    delta: i128,
    side: BetSide,
    b: i128,
) -> Result<i128, ContractError> {
    if b < LMSR_B_MIN {
        return Err(ContractError::InvalidConfig);
    }

    let lse_old = log_sum_exp(q_a, q_b, q_draw, b)?;

    let (q_a_new, q_b_new, q_d_new) = match side {
        BetSide::FighterA => (q_a + delta, q_b, q_draw),
        BetSide::FighterB => (q_a, q_b + delta, q_draw),
        BetSide::Draw     => (q_a, q_b, q_draw + delta),
    };

    let lse_new = log_sum_exp(q_a_new, q_b_new, q_d_new, b)?;

    // cost = b * (lse_new - lse_old) / LMSR_SCALE
    // lse values are in fixed-point (× LMSR_SCALE); b is in stroops.
    // Overflow guard: b * diff ≤ b * (delta * LMSR_SCALE / b) = delta * LMSR_SCALE.
    // delta ≤ 10^15 stroops, LMSR_SCALE = 10^9 → product ≤ 10^24 < i128::MAX.
    let diff = lse_new - lse_old; // always ≥ 0 for delta > 0
    let cost = b
        .checked_mul(diff)
        .ok_or(ContractError::ArithmeticOverflow)?
        / LMSR_SCALE;

    Ok(cost.max(1)) // enforce strictly positive (floor of 0 → 1 stroop minimum)
}

/// Computes the LMSR implied probability for outcome `side` in basis points (0–10_000).
///
/// # Formula
/// p_i = e^{q_i/b} / (e^{q_a/b} + e^{q_b/b} + e^{q_draw/b})
///
/// Uses log-sum-exp normalization; returned as integer in basis points.
/// Sum of all three prices equals 10_000 within 1 bp rounding.
///
/// # Errors
/// Same as `lmsr_cost`.
pub fn lmsr_price(
    q_a: i128,
    q_b: i128,
    q_draw: i128,
    side: BetSide,
    b: i128,
) -> Result<i128, ContractError> {
    if b < LMSR_B_MIN {
        return Err(ContractError::InvalidConfig);
    }

    // Fixed-point exponents: x_i = q_i * LMSR_SCALE / b
    let a_fp = q_a.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;
    let b_fp = q_b.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;
    let d_fp = q_draw.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;

    // log-sum-exp shift: subtract max so all arguments ≤ 0
    let max_fp = a_fp.max(b_fp).max(d_fp);
    let e_a = lmsr_exp(a_fp - max_fp, 15)?;
    let e_b = lmsr_exp(b_fp - max_fp, 15)?;
    let e_d = lmsr_exp(d_fp - max_fp, 15)?;
    let sum = e_a + e_b + e_d;

    if sum == 0 {
        return Err(ContractError::ArithmeticOverflow);
    }

    let e_i = match side {
        BetSide::FighterA => e_a,
        BetSide::FighterB => e_b,
        BetSide::Draw     => e_d,
    };

    Ok(e_i * 10_000 / sum)
}

// ─── Internal: log-sum-exp in fixed-point ────────────────────────────────────

/// Returns max(q/b) + ln(Σ e^{(q_i - max)/b}) in fixed-point (× LMSR_SCALE).
/// All exp arguments are ≤ 0 so lmsr_exp never overflows here.
fn log_sum_exp(q_a: i128, q_b: i128, q_draw: i128, b: i128) -> Result<i128, ContractError> {
    let a_fp = q_a.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;
    let b_fp = q_b.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;
    let d_fp = q_draw.checked_mul(LMSR_SCALE).ok_or(ContractError::ArithmeticOverflow)? / b;

    let max_fp = a_fp.max(b_fp).max(d_fp);

    // All shifted args ≤ 0, so lmsr_exp is safe.
    let e_a = lmsr_exp(a_fp - max_fp, 15)?;
    let e_b = lmsr_exp(b_fp - max_fp, 15)?;
    let e_d = lmsr_exp(d_fp - max_fp, 15)?;
    let sum_fp = e_a + e_b + e_d; // ∈ [LMSR_SCALE, 3*LMSR_SCALE]

    // ln(sum_fp / LMSR_SCALE) in fixed-point
    let ln_sum = lmsr_ln(sum_fp, 15)?;

    // log_sum_exp = max(q/b) + ln(sum) — both in fixed-point
    max_fp.checked_add(ln_sum).ok_or(ContractError::ArithmeticOverflow)
}

// ─── Legacy LP fee helpers ────────────────────────────────────────────────────

/// Computes the maximum collateral a buyer can spend without draining the target
/// reserve to zero (constant-product AMM guard — kept for treasury/LP fee code).
pub fn calc_max_trade(reserve: i128, _balance: i128) -> i128 {
    if reserve <= 1 {
        return 0;
    }
    reserve - 1
}

/// Calculates claimable LP fees for a position using the fee-per-share accumulator.
pub fn calc_claimable_lp_fees(
    lp_fee_per_share: i128,
    lp_fee_debt: i128,
    lp_shares: i128,
) -> i128 {
    if lp_shares <= 0 {
        return 0;
    }
    let fee_delta = lp_fee_per_share.saturating_sub(lp_fee_debt);
    fee_delta.saturating_mul(lp_shares) / 1_000_000
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const B: i128 = 10_000_000_000i128; // 1000 XLM default

    // ── lmsr_cost: basic properties ─────────────────────────────────────────

    #[test]
    fn cost_is_positive_for_any_delta() {
        // Marginal cost must always be > 0 for delta > 0.
        let q_a = 5_000_000_000i128;
        let q_b = 3_000_000_000i128;
        let q_d = 2_000_000_000i128;
        let delta = 1_000_000i128; // 0.1 XLM

        let cost = lmsr_cost(q_a, q_b, q_d, delta, BetSide::FighterA, B).unwrap();
        assert!(cost > 0, "LMSR marginal cost must be strictly positive");
    }

    #[test]
    fn cost_less_than_delta_in_any_pool() {
        // LMSR cost is always < delta (bettors can't be charged more than their bet).
        let delta = 100_000_000i128; // 10 XLM
        for (qa, qb, qd) in [
            (0i128, 0, 0),
            (1_000_000_000, 0, 0),
            (1_000_000_000, 1_000_000_000, 1_000_000_000),
            (50_000_000_000, 0, 0),
        ] {
            let cost = lmsr_cost(qa, qb, qd, delta, BetSide::FighterA, B).unwrap();
            assert!(
                cost <= delta,
                "LMSR cost {cost} must be ≤ delta {delta} for pools ({qa},{qb},{qd})"
            );
        }
    }

    #[test]
    fn cost_is_monotone_increasing_with_delta() {
        let q_a = 1_000_000_000i128;
        let q_b = 1_000_000_000i128;
        let q_d = 1_000_000_000i128;
        let delta_small = 10_000_000i128;
        let delta_large = 100_000_000i128;

        let c1 = lmsr_cost(q_a, q_b, q_d, delta_small, BetSide::FighterA, B).unwrap();
        let c2 = lmsr_cost(q_a, q_b, q_d, delta_large, BetSide::FighterA, B).unwrap();
        assert!(c2 > c1, "Larger bet must cost more: c1={c1}, c2={c2}");
    }

    #[test]
    fn small_bet_price_impact_proportional_to_delta_over_b() {
        // LMSR price impact for δ << b is approximately 2δ/(9b) bps on a balanced
        // 3-way market (from the second derivative of the cost function).
        // For δ/b = 0.01 (10 XLM on b=1000 XLM), expected move ≈ 2 bps.
        let b: i128 = 10_000_000_000; // 1000 XLM
        let q_a: i128 = 5_000_000_000; // balanced 500 XLM per side
        let q_b: i128 = 5_000_000_000;
        let q_d: i128 = 5_000_000_000;

        let price_before = lmsr_price(q_a, q_b, q_d, BetSide::FighterA, b).unwrap();

        let delta: i128 = 100_000_000; // 10 XLM = 0.01 * b
        let cost = lmsr_cost(q_a, q_b, q_d, delta, BetSide::FighterA, b).unwrap();
        let q_a_new = q_a + cost;
        let price_after = lmsr_price(q_a_new, q_b, q_d, BetSide::FighterA, b).unwrap();

        let move_bps = (price_after - price_before).abs();
        // For δ/b = 0.01, theoretical move ≈ 2 bps; allow up to 10 bps tolerance.
        assert!(
            move_bps < 10,
            "Price moved {move_bps} bps for δ=10 XLM, b=1000 XLM; expected < 10 bps"
        );
    }

    // ── lmsr_price: probability properties ──────────────────────────────────

    #[test]
    fn prices_sum_to_10000_bps() {
        let q_a = 7_000_000_000i128;
        let q_b = 2_000_000_000i128;
        let q_d = 1_000_000_000i128;

        let p_a = lmsr_price(q_a, q_b, q_d, BetSide::FighterA, B).unwrap();
        let p_b = lmsr_price(q_a, q_b, q_d, BetSide::FighterB, B).unwrap();
        let p_d = lmsr_price(q_a, q_b, q_d, BetSide::Draw,     B).unwrap();
        let total = p_a + p_b + p_d;

        assert!(
            (total - 10_000).abs() <= 2,
            "LMSR prices sum to {total}, expected 10_000 ± 2 bps"
        );
    }

    #[test]
    fn equal_pools_give_equal_prices() {
        let q = 3_000_000_000i128;
        let p_a = lmsr_price(q, q, q, BetSide::FighterA, B).unwrap();
        let p_b = lmsr_price(q, q, q, BetSide::FighterB, B).unwrap();
        let p_d = lmsr_price(q, q, q, BetSide::Draw,     B).unwrap();

        // Each should be ~3333 bps
        assert!((p_a - 3_333).abs() <= 2, "Equal pools: p_a = {p_a}");
        assert!((p_b - 3_333).abs() <= 2, "Equal pools: p_b = {p_b}");
        assert!((p_d - 3_333).abs() <= 2, "Equal pools: p_d = {p_d}");
    }

    #[test]
    fn dominant_pool_has_highest_price() {
        let q_a = 90_000_000_000i128; // 9000 XLM
        let q_b = 5_000_000_000i128;
        let q_d = 5_000_000_000i128;

        let p_a = lmsr_price(q_a, q_b, q_d, BetSide::FighterA, B).unwrap();
        let p_b = lmsr_price(q_a, q_b, q_d, BetSide::FighterB, B).unwrap();
        let p_d = lmsr_price(q_a, q_b, q_d, BetSide::Draw,     B).unwrap();

        assert!(p_a > p_b, "FighterA should be favorite: p_a={p_a}, p_b={p_b}");
        assert!(p_a > p_d, "FighterA should be favorite: p_a={p_a}, p_d={p_d}");
    }

    #[test]
    fn invalid_b_returns_error() {
        let result = lmsr_cost(0, 0, 0, 1_000_000, BetSide::FighterA, LMSR_B_MIN - 1);
        assert!(result.is_err(), "b below minimum must return InvalidConfig");
    }

    // ── Sequential bets converge odds toward correct probability ─────────────

    #[test]
    fn sequential_bets_converge_odds() {
        // After 100 bets on FighterA, its price should rise substantially above 3333.
        let mut q_a: i128 = 0;
        let q_b: i128 = 0;
        let q_d: i128 = 0;
        let delta: i128 = 100_000_000; // 10 XLM per bet

        for _ in 0..100 {
            let cost = lmsr_cost(q_a, q_b, q_d, delta, BetSide::FighterA, B).unwrap();
            q_a += cost;
        }

        let p_a = lmsr_price(q_a, q_b, q_d, BetSide::FighterA, B).unwrap();
        // 100 bets × 10 XLM ≈ 1000 XLM total = 1× b. At this scale the price
        // rises to ~4200 bps — above the uniform prior (3333) but below 50%.
        assert!(
            p_a > 4_000,
            "After 100 bets on FighterA, p_a should be > 4000 bps, got {p_a}"
        );
    }
}
