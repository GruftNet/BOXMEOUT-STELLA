//! ============================================================
//! BOXMEOUT — Math Utilities
//! Integer-only arithmetic for Soroban WASM (no f32/f64).
//! All LMSR functions use 64-bit fixed-point with SCALE = 10^9.
//! ============================================================

use crate::errors::ContractError;

/// Fixed-point scale: 1.0 == LMSR_SCALE. All exp/ln inputs and outputs are
/// multiples of this constant (x_fp = x * LMSR_SCALE).
pub const LMSR_SCALE: i128 = 1_000_000_000;

/// ln(2) in fixed-point: floor(0.693147180559945 * LMSR_SCALE).
const LN2_FP: i128 = 693_147_180;

/// Upper bound on |x| for lmsr_exp. e^43 * LMSR_SCALE ≈ 4.7 × 10^27 < i128::MAX.
const EXP_MAX_FP: i128 = 43 * LMSR_SCALE;

/// Below this threshold e^x < 10^{-18}; we clamp to zero to avoid underflow.
const EXP_MIN_FP: i128 = -43 * LMSR_SCALE;

// ─── Existing utilities ───────────────────────────────────────────────────────

/// Returns |a - b| without overflow for any i128 pair.
pub fn abs_diff(a: i128, b: i128) -> i128 {
    if a >= b {
        a.wrapping_sub(b)
    } else {
        b.wrapping_sub(a)
    }
}

/// Clamps `val` to [min_val, max_val].
pub fn clamp(val: i128, min_val: i128, max_val: i128) -> i128 {
    if val < min_val {
        min_val
    } else if val > max_val {
        max_val
    } else {
        val
    }
}

// ─── LMSR fixed-point exponential ────────────────────────────────────────────

/// Computes e^(x_fp / LMSR_SCALE) * LMSR_SCALE using integer arithmetic only.
///
/// # Algorithm
/// Range reduction: x = n·ln(2) + r, r ∈ [0, ln2).
/// Taylor series for e^r (order `precision`, max 20):
///   e^r ≈ Σ_{k=0}^{p} r^k / k!   (truncation error < r^{p+1} / (p+1)!)
/// For r < ln(2) ≈ 0.693 and p = 15: max absolute error < 0.693^16/16! ≈ 7 × 10^{-14}.
/// Then e^x = e^r · 2^n via i128 bit-shift.
///
/// # Arguments
/// * `x_fp`      — x in fixed-point (x_fp = x · LMSR_SCALE)
/// * `precision` — Taylor series terms (clamped to [4, 20])
///
/// # Errors
/// Returns `ArithmeticOverflow` if x_fp > EXP_MAX_FP or a term overflows i128.
///
/// # Domain
/// x_fp ∈ [EXP_MIN_FP, EXP_MAX_FP] = [-43·SCALE, 43·SCALE].
/// Values below EXP_MIN_FP return 0 (underflow clamp; e^{-43} < 10^{-18}).
pub fn lmsr_exp(x_fp: i128, precision: u32) -> Result<i128, ContractError> {
    if x_fp < EXP_MIN_FP {
        return Ok(0);
    }
    if x_fp > EXP_MAX_FP {
        return Err(ContractError::ArithmeticOverflow);
    }

    let terms = precision.clamp(4, 20) as i128;

    // Range reduction: x = n*ln2 + r, r ∈ [0, ln2).
    // div_euclid/rem_euclid give the correct floor division for negative x_fp.
    let n = x_fp.div_euclid(LN2_FP);   // n ∈ [-62, 62]
    let r_fp = x_fp.rem_euclid(LN2_FP); // r_fp ∈ [0, LN2_FP)

    // Taylor series: e^r * SCALE, r_fp = r * SCALE, r ∈ [0, 0.694)
    // term_k = r^k / k! * SCALE, computed iteratively to avoid huge intermediates.
    // Maximum intermediate: term * r_fp ≤ 2*SCALE * LN2_FP ≈ 1.39 × 10^18 < i128::MAX.
    let mut sum: i128 = LMSR_SCALE; // k=0 term: 1 * SCALE
    let mut term: i128 = LMSR_SCALE;
    let mut k: i128 = 1;
    while k <= terms {
        term = term
            .checked_mul(r_fp)
            .ok_or(ContractError::ArithmeticOverflow)?
            / (k * LMSR_SCALE);
        sum = sum.checked_add(term).ok_or(ContractError::ArithmeticOverflow)?;
        k += 1;
    }

    // Scale by 2^n: left-shift for n > 0, right-shift for n < 0.
    if n >= 0 {
        let shift = n as u32;
        // Guard: sum ≤ 2*SCALE = 2e9 < 2^31; shifting by 62 gives ≤ 9.2e27 < i128::MAX.
        sum.checked_shl(shift).ok_or(ContractError::ArithmeticOverflow)
    } else {
        let shift = (-n) as u32;
        Ok(sum >> shift) // right-shift always in range; may produce 0 for large |n|
    }
}

// ─── LMSR fixed-point natural logarithm ──────────────────────────────────────

/// Computes ln(x_fp / LMSR_SCALE) * LMSR_SCALE using integer arithmetic only.
///
/// # Algorithm
/// Range reduction: find n such that u = x_fp / 2^n ∈ [SCALE, 2·SCALE).
/// Arctanh identity: ln(u/SCALE) = 2 · arctanh((u - SCALE) / (u + SCALE)).
/// Series (order `precision`, max 20):
///   arctanh(t) = t + t^3/3 + t^5/5 + ...   (converges for |t| < 1)
/// For u ∈ [SCALE, 2·SCALE): t = (u-SCALE)/(u+SCALE) ∈ [0, 1/3).
/// Truncation error < t^{2p+1}/(2p+1) ≤ (1/3)^{2p+1}/(2p+1).
/// For p = 15: error < (1/3)^31/31 ≈ 3 × 10^{-16} * SCALE.
/// Then ln(x) = ln(u/SCALE) + n * ln(2).
///
/// # Arguments
/// * `x_fp`      — x in fixed-point (x_fp = x · LMSR_SCALE), must be > 0
/// * `precision` — Taylor series terms (clamped to [4, 20])
///
/// # Errors
/// Returns `ArithmeticOverflow` if x_fp ≤ 0 or an intermediate overflows.
pub fn lmsr_ln(x_fp: i128, precision: u32) -> Result<i128, ContractError> {
    if x_fp <= 0 {
        return Err(ContractError::ArithmeticOverflow);
    }

    let terms = precision.clamp(4, 20) as i128;

    // Range reduction: find n such that u ∈ [SCALE, 2*SCALE).
    // x = u * 2^n  =>  ln(x/SCALE) = ln(u/SCALE) + n*ln(2).
    let mut u = x_fp;
    let mut n: i128 = 0;
    while u >= 2 * LMSR_SCALE {
        u >>= 1;
        n += 1;
    }
    while u < LMSR_SCALE {
        u <<= 1;
        n -= 1;
    }
    // u ∈ [SCALE, 2*SCALE), n chosen so that x_fp = u * 2^n (approximately,
    // with at most 1-bit error from shift, acceptable for this precision).

    // t = (u - SCALE) / (u + SCALE), t ∈ [0, 1/3).
    // t_fp = t * SCALE.
    // Numerator: (u - SCALE) * SCALE ≤ SCALE * SCALE = 10^18 < i128::MAX.
    let numer = (u - LMSR_SCALE)
        .checked_mul(LMSR_SCALE)
        .ok_or(ContractError::ArithmeticOverflow)?;
    let denom = u + LMSR_SCALE; // ∈ [2*SCALE, 3*SCALE)
    let t_fp = numer / denom;   // t_fp ∈ [0, SCALE/3)

    // u2 = t^2 * SCALE = t_fp^2 / SCALE.
    // t_fp ≤ SCALE/3 ≈ 3.3e8; t_fp^2 ≤ 1.1e17 < i128::MAX.
    let t2_fp = t_fp
        .checked_mul(t_fp)
        .ok_or(ContractError::ArithmeticOverflow)?
        / LMSR_SCALE;

    // arctanh(t) = Σ_{k=0}^{p} t^{2k+1} / (2k+1) * SCALE
    // Series in fixed-point: multiply term by t^2 each iteration.
    let mut arctanh_fp: i128 = t_fp; // k=0: t * SCALE
    let mut term: i128 = t_fp;
    let mut k: i128 = 1;
    while k <= terms {
        term = term
            .checked_mul(t2_fp)
            .ok_or(ContractError::ArithmeticOverflow)?
            / LMSR_SCALE;
        arctanh_fp += term / (2 * k + 1);
        k += 1;
    }

    // ln(u/SCALE) = 2 * arctanh(t)
    let ln_u = arctanh_fp.checked_mul(2).ok_or(ContractError::ArithmeticOverflow)?;

    // ln(x/SCALE) = ln(u/SCALE) + n * ln2
    let n_ln2 = n
        .checked_mul(LN2_FP)
        .ok_or(ContractError::ArithmeticOverflow)?;
    ln_u.checked_add(n_ln2).ok_or(ContractError::ArithmeticOverflow)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i128 = i128::MIN;
    const MAX: i128 = i128::MAX;

    // ── Existing utility tests ───────────────────────────────────────────────

    #[test]
    fn abs_diff_normal() {
        assert_eq!(abs_diff(10, 3), 7);
        assert_eq!(abs_diff(3, 10), 7);
        assert_eq!(abs_diff(-5, 5), 10);
        assert_eq!(abs_diff(0, 0), 0);
    }

    #[test]
    fn abs_diff_boundaries() {
        assert_eq!(abs_diff(MAX, 0), MAX);
        assert_eq!(abs_diff(MIN, MIN), 0);
        assert_eq!(abs_diff(MAX, MAX), 0);
        assert_eq!(abs_diff(MAX, MAX - 1), 1);
        assert_eq!(abs_diff(MIN, MIN + 1), 1);
    }

    #[test]
    fn clamp_normal() {
        assert_eq!(clamp(5, 1, 10), 5);
        assert_eq!(clamp(0, 1, 10), 1);
        assert_eq!(clamp(11, 1, 10), 10);
        assert_eq!(clamp(1, 1, 10), 1);
        assert_eq!(clamp(10, 1, 10), 10);
    }

    #[test]
    fn clamp_boundaries() {
        assert_eq!(clamp(MIN, MIN, MAX), MIN);
        assert_eq!(clamp(MAX, MIN, MAX), MAX);
        assert_eq!(clamp(0, MIN, MAX), 0);
        assert_eq!(clamp(MIN, 0, MAX), 0);
        assert_eq!(clamp(MAX, MIN, 0), 0);
    }

    // ── lmsr_exp tests ──────────────────────────────────────────────────────

    #[test]
    fn exp_zero_is_one() {
        let result = lmsr_exp(0, 15).unwrap();
        assert_eq!(result, LMSR_SCALE, "e^0 must equal LMSR_SCALE (1 in fixed-point)");
    }

    #[test]
    fn exp_underflow_clamps_to_zero() {
        assert_eq!(lmsr_exp(EXP_MIN_FP - 1, 15).unwrap(), 0);
        assert_eq!(lmsr_exp(-100 * LMSR_SCALE, 15).unwrap(), 0);
    }

    #[test]
    fn exp_overflow_returns_error() {
        assert!(lmsr_exp(EXP_MAX_FP + 1, 15).is_err());
    }

    #[test]
    fn exp_at_ln2_is_two() {
        // e^ln(2) == 2, so result ≈ 2 * SCALE within 0.01%
        let result = lmsr_exp(LN2_FP, 15).unwrap();
        let expected = 2 * LMSR_SCALE;
        let tol = expected / 10_000; // 0.01%
        assert!(
            (result - expected).abs() <= tol,
            "e^ln2 = {result}, expected {expected} ± {tol}"
        );
    }

    #[test]
    fn exp_negative_one() {
        // e^{-1} ≈ 0.367879441 → 367_879_441 in fixed-point
        let result = lmsr_exp(-LMSR_SCALE, 15).unwrap();
        let expected: i128 = 367_879_441;
        let tol = expected / 10_000; // 0.01%
        assert!(
            (result - expected).abs() <= tol,
            "e^-1 = {result}, expected ~{expected}"
        );
    }

    #[test]
    fn exp_positive_one() {
        // e^1 ≈ 2.718281828 → 2_718_281_828 in fixed-point
        let result = lmsr_exp(LMSR_SCALE, 15).unwrap();
        let expected: i128 = 2_718_281_828;
        let tol = expected / 10_000;
        assert!(
            (result - expected).abs() <= tol,
            "e^1 = {result}, expected ~{expected}"
        );
    }

    #[test]
    fn exp_ten() {
        // e^10 ≈ 22026.4657948 → 22_026_465_794_800 in fixed-point (×SCALE)
        // Actually e^10 * LMSR_SCALE = 22026.4657... * 10^9 = 2.2026... × 10^13
        let result = lmsr_exp(10 * LMSR_SCALE, 15).unwrap();
        let expected: i128 = 22_026_465_794_800i128;
        let tol = expected / 10_000;
        assert!(
            (result - expected).abs() <= tol,
            "e^10 = {result}, expected ~{expected}"
        );
    }

    #[test]
    fn exp_negative_ten() {
        // e^{-10} ≈ 0.0000453999 → 45_399 in fixed-point
        let result = lmsr_exp(-10 * LMSR_SCALE, 15).unwrap();
        let expected: i128 = 45_399;
        // Allow 1% tolerance since the value is small
        let tol = (expected / 100).max(10);
        assert!(
            (result - expected).abs() <= tol,
            "e^-10 = {result}, expected ~{expected}"
        );
    }

    // ── lmsr_ln tests ───────────────────────────────────────────────────────

    #[test]
    fn ln_zero_or_negative_returns_error() {
        assert!(lmsr_ln(0, 15).is_err());
        assert!(lmsr_ln(-1, 15).is_err());
    }

    #[test]
    fn ln_one_is_zero() {
        // ln(1) = 0
        let result = lmsr_ln(LMSR_SCALE, 15).unwrap();
        assert!(result.abs() < 1_000, "ln(1) must be ~0, got {result}");
    }

    #[test]
    fn ln_two() {
        // ln(2) ≈ 0.693147 → LN2_FP = 693_147_180
        let result = lmsr_ln(2 * LMSR_SCALE, 15).unwrap();
        let tol = LN2_FP / 10_000;
        assert!(
            (result - LN2_FP).abs() <= tol,
            "ln(2) = {result}, expected ~{LN2_FP}"
        );
    }

    #[test]
    fn ln_e_is_one() {
        // ln(e) = 1; e ≈ 2_718_281_828
        let e_fp: i128 = 2_718_281_828;
        let result = lmsr_ln(e_fp, 15).unwrap();
        let tol = LMSR_SCALE / 10_000;
        assert!(
            (result - LMSR_SCALE).abs() <= tol,
            "ln(e) = {result}, expected ~{LMSR_SCALE}"
        );
    }

    // ── Property tests: exp(ln(x)) ≈ x within 0.01% for x ∈ [1, 10^15] ─────

    #[test]
    fn exp_ln_roundtrip_x1() {
        roundtrip_check(LMSR_SCALE); // x = 1
    }

    #[test]
    fn exp_ln_roundtrip_x2() {
        roundtrip_check(2 * LMSR_SCALE); // x = 2
    }

    #[test]
    fn exp_ln_roundtrip_x1000() {
        roundtrip_check(1_000 * LMSR_SCALE); // x = 1000
    }

    #[test]
    fn exp_ln_roundtrip_x1e12() {
        roundtrip_check(1_000_000_000_000i128 * LMSR_SCALE); // x = 10^12
    }

    fn roundtrip_check(x_fp: i128) {
        let ln_x = lmsr_ln(x_fp, 15).unwrap();
        let recovered = lmsr_exp(ln_x, 15).unwrap();
        // Allow 0.01% error
        let tol = x_fp / 10_000;
        assert!(
            (recovered - x_fp).abs() <= tol.max(1_000),
            "exp(ln({x_fp})) = {recovered}, expected {x_fp} ± {tol}"
        );
    }

    // ── LMSR price property: sum must equal 10_000 basis points ──────────────

    #[test]
    fn lmsr_prices_sum_to_basis_points() {
        // Use the amm module's lmsr_price via direct math to verify
        // that normalizing by the sum always yields exactly 10_000.
        // (The amm::lmsr_cost/price tests live in amm.rs.)
        let b: i128 = 10_000_000_000; // 1000 XLM in stroops
        let q_a: i128 = 5_000_000_000;
        let q_b: i128 = 3_000_000_000;
        let q_d: i128 = 2_000_000_000;

        let a_fp = q_a * LMSR_SCALE / b;
        let b_fp = q_b * LMSR_SCALE / b;
        let d_fp = q_d * LMSR_SCALE / b;

        let max_fp = a_fp.max(b_fp).max(d_fp);
        let e_a = lmsr_exp(a_fp - max_fp, 15).unwrap();
        let e_b = lmsr_exp(b_fp - max_fp, 15).unwrap();
        let e_d = lmsr_exp(d_fp - max_fp, 15).unwrap();
        let sum = e_a + e_b + e_d;

        let p_a = e_a * 10_000 / sum;
        let p_b = e_b * 10_000 / sum;
        let p_d = e_d * 10_000 / sum;
        let total = p_a + p_b + p_d;

        assert!(
            (total as i64 - 10_000i64).abs() <= 2,
            "LMSR prices sum to {total}, expected 10_000 ± 2 bps"
        );
    }
}
