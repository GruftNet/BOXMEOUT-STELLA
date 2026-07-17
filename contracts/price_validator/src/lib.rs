#![no_std]
//! ============================================================
//! BOXMEOUT — PriceValidator Contract
//! Cross-checks price submissions from multiple oracle sources,
//! rejects stale/outlier data, and scores each source's confidence
//! before a validated price is allowed to reach a market.
//! ============================================================

#[cfg(test)]
mod tests;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, String, Symbol, Vec};

use boxmeout_shared::errors::ContractError;
use boxmeout_shared::math::abs_diff;

// === Storage Keys
const ADMIN: &str = "ADMIN";
const SUBMISSIONS: &str = "SUBS";
const CONFIDENCE: &str = "CONF";
const LAST_REPORT: &str = "LAST_RPT";

// === Config
/// Prices older than this (in ledger seconds) are rejected as stale.
const STALENESS_THRESHOLD_SECS: u64 = 900; // 15 minutes
/// Multi-source disagreement above this is flagged in the validation report.
const DEVIATION_THRESHOLD_BPS: u32 = 200; // 2%
/// Points beyond this many standard deviations from the mean are outliers.
const SIGMA_MULTIPLIER: i128 = 3;
const BPS_SCALE: i128 = 10_000;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceSubmission {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ValidationReport {
    /// Confidence-weighted aggregate price across surviving sources.
    pub validated_price: i128,
    /// Overall confidence in `validated_price`, in basis points (0-10000).
    pub confidence_bps: u32,
    /// Sources that passed staleness and outlier checks.
    pub sources_used: Vec<Symbol>,
    /// Sources excluded for exceeding the staleness threshold.
    pub sources_stale: Vec<Symbol>,
    /// Sources excluded by 3-sigma outlier filtering.
    pub sources_outlier: Vec<Symbol>,
    /// Largest deviation of any surviving source from consensus, in bps.
    pub max_deviation_bps: u32,
    /// True if `max_deviation_bps` exceeded `DEVIATION_THRESHOLD_BPS`.
    pub deviation_flagged: bool,
    pub validated_at: u64,
}

#[contract]
pub struct PriceValidator;

// === Internal helpers
impl PriceValidator {
    fn load_submissions(env: &Env) -> Map<Symbol, PriceSubmission> {
        env.storage().persistent().get(&SUBMISSIONS).unwrap_or_else(|| Map::new(env))
    }

    fn save_submissions(env: &Env, m: &Map<Symbol, PriceSubmission>) {
        env.storage().persistent().set(&SUBMISSIONS, m);
    }

    fn load_confidence(env: &Env) -> Map<Symbol, u32> {
        env.storage().persistent().get(&CONFIDENCE).unwrap_or_else(|| Map::new(env))
    }

    fn save_confidence(env: &Env, m: &Map<Symbol, u32>) {
        env.storage().persistent().set(&CONFIDENCE, m);
    }

    /// Insertion sort (source lists are small — a handful of oracle feeds).
    fn sorted(values: &Vec<i128>) -> Vec<i128> {
        let mut v = values.clone();
        let n = v.len();
        for i in 1..n {
            let key = v.get(i).unwrap();
            let mut j = i;
            while j > 0 && v.get(j - 1).unwrap() > key {
                let prev = v.get(j - 1).unwrap();
                v.set(j, prev);
                j -= 1;
            }
            v.set(j, key);
        }
        v
    }

    fn median(sorted_vals: &Vec<i128>) -> i128 {
        let n = sorted_vals.len();
        if n == 0 {
            return 0;
        }
        let mid = n / 2;
        if n % 2 == 1 {
            sorted_vals.get(mid).unwrap()
        } else {
            let a = sorted_vals.get(mid - 1).unwrap();
            let b = sorted_vals.get(mid).unwrap();
            (a + b) / 2
        }
    }

    /// |price - reference| / reference, in basis points, clamped to 10_000.
    fn deviation_bps(price: i128, reference: i128) -> u32 {
        if reference <= 0 {
            return 0;
        }
        let diff = abs_diff(price, reference);
        let bps = diff.saturating_mul(BPS_SCALE) / reference;
        bps.min(BPS_SCALE) as u32
    }

    fn mean(prices: &Vec<i128>) -> i128 {
        let n = prices.len() as i128;
        if n == 0 {
            return 0;
        }
        let sum: i128 = prices.iter().sum();
        sum / n
    }

    /// Removes points more than `SIGMA_MULTIPLIER` median-absolute-deviations
    /// (MAD) from the median. MAD is used instead of mean/stddev because a
    /// single extreme outlier otherwise inflates the mean and stddev enough
    /// to mask itself (the standard "masking" failure of non-robust
    /// statistics on small samples) — MAD stays anchored to the majority.
    /// Skipped when fewer than 3 points (not enough to be statistically
    /// meaningful) or when the outlier set would be everything (falls back
    /// to the pre-filter set rather than discarding all data).
    fn filter_outliers(
        env: &Env,
        fresh: &Vec<(Symbol, i128)>,
    ) -> (Vec<(Symbol, i128)>, Vec<Symbol>) {
        if fresh.len() < 3 {
            return (fresh.clone(), Vec::new(env));
        }

        let mut prices: Vec<i128> = Vec::new(env);
        for (_, price) in fresh.iter() {
            prices.push_back(price);
        }
        let med = Self::median(&Self::sorted(&prices));

        let mut abs_devs: Vec<i128> = Vec::new(env);
        for p in prices.iter() {
            abs_devs.push_back(abs_diff(p, med));
        }
        let mad = Self::median(&Self::sorted(&abs_devs));

        let mut kept: Vec<(Symbol, i128)> = Vec::new(env);
        let mut outliers: Vec<Symbol> = Vec::new(env);

        if mad == 0 {
            // At least half the sources agree exactly with the median —
            // anything else is an unambiguous outlier.
            for (source, price) in fresh.iter() {
                if price == med {
                    kept.push_back((source, price));
                } else {
                    outliers.push_back(source);
                }
            }
        } else {
            let threshold = mad * SIGMA_MULTIPLIER;
            for (source, price) in fresh.iter() {
                if abs_diff(price, med) > threshold {
                    outliers.push_back(source);
                } else {
                    kept.push_back((source, price));
                }
            }
        }

        if kept.is_empty() {
            return (fresh.clone(), Vec::new(env));
        }
        (kept, outliers)
    }

    fn emit_rejected(env: &Env, reason: &str) {
        let topics = (Symbol::new(env, "price_validation_rejected"),);
        env.events().publish(topics, String::from_str(env, reason));
    }
}

#[contractimpl]
impl PriceValidator {
    // =========================================================================
    // INITIALIZE
    // =========================================================================
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().persistent().set(&SUBMISSIONS, &Map::<Symbol, PriceSubmission>::new(&env));
        env.storage().persistent().set(&CONFIDENCE, &Map::<Symbol, u32>::new(&env));
        Ok(())
    }

    // =========================================================================
    // SUBMIT PRICE
    // =========================================================================
    /// Records the latest price reported by `oracle` for `source` (e.g. a
    /// Symbol identifying "chainlink", "uniswap", or "pyth"). Overwrites any
    /// previous submission for that source.
    pub fn submit_price(
        env: Env,
        oracle: Address,
        source: Symbol,
        price: i128,
    ) -> Result<(), ContractError> {
        oracle.require_auth();
        if price <= 0 {
            return Err(ContractError::InvalidPriceSubmission);
        }
        let mut subs = Self::load_submissions(&env);
        subs.set(
            source,
            PriceSubmission { price, timestamp: env.ledger().timestamp() },
        );
        Self::save_submissions(&env, &subs);
        Ok(())
    }

    // =========================================================================
    // VALIDATE PRICE — pre-settlement gate
    // =========================================================================
    /// Cross-checks all submitted sources, drops stale and outlier data,
    /// and returns a confidence-weighted validated price. Callers (e.g. a
    /// market's settlement flow) must call this before trusting a price.
    ///
    /// # Errors
    /// - `StalePriceData`: every submission is older than the staleness window
    /// - `InsufficientPriceSources`: no submissions exist at all
    pub fn validate_price(env: Env) -> Result<ValidationReport, ContractError> {
        let submissions = Self::load_submissions(&env);
        if submissions.is_empty() {
            Self::emit_rejected(&env, "no_sources");
            return Err(ContractError::InsufficientPriceSources);
        }

        let now = env.ledger().timestamp();
        let mut fresh: Vec<(Symbol, i128)> = Vec::new(&env);
        let mut ages: Map<Symbol, u64> = Map::new(&env);
        let mut sources_stale: Vec<Symbol> = Vec::new(&env);

        for (source, sub) in submissions.iter() {
            let age = now.saturating_sub(sub.timestamp);
            if age > STALENESS_THRESHOLD_SECS {
                sources_stale.push_back(source);
            } else {
                fresh.push_back((source.clone(), sub.price));
                ages.set(source, age);
            }
        }

        if fresh.is_empty() {
            Self::emit_rejected(&env, "all_sources_stale");
            return Err(ContractError::StalePriceData);
        }

        let (kept, sources_outlier) = Self::filter_outliers(&env, &fresh);

        let mut kept_prices: Vec<i128> = Vec::new(&env);
        for (_, price) in kept.iter() {
            kept_prices.push_back(price);
        }
        let consensus = Self::mean(&kept_prices);

        // Confidence per surviving source: average of freshness and accuracy.
        let mut confidence_map = Self::load_confidence(&env);
        let mut sources_used: Vec<Symbol> = Vec::new(&env);
        let mut max_deviation_bps: u32 = 0;
        let mut weighted_sum: i128 = 0;
        let mut weight_total: i128 = 0;

        for (source, price) in kept.iter() {
            let age = ages.get(source.clone()).unwrap_or(STALENESS_THRESHOLD_SECS);
            let freshness_bps = if age >= STALENESS_THRESHOLD_SECS {
                0u32
            } else {
                (BPS_SCALE - (age as i128 * BPS_SCALE / STALENESS_THRESHOLD_SECS as i128)) as u32
            };
            let deviation_bps = Self::deviation_bps(price, consensus);
            let accuracy_bps = BPS_SCALE as u32 - deviation_bps;
            let confidence_bps = (freshness_bps + accuracy_bps) / 2;

            if deviation_bps > max_deviation_bps {
                max_deviation_bps = deviation_bps;
            }

            confidence_map.set(source.clone(), confidence_bps);
            sources_used.push_back(source);
            weighted_sum += price * confidence_bps as i128;
            weight_total += confidence_bps as i128;
        }
        Self::save_confidence(&env, &confidence_map);

        let validated_price = if weight_total > 0 { weighted_sum / weight_total } else { consensus };
        let overall_confidence_bps = if !sources_used.is_empty() {
            (weight_total / sources_used.len() as i128) as u32
        } else {
            0
        };
        let deviation_flagged = max_deviation_bps > DEVIATION_THRESHOLD_BPS;

        let report = ValidationReport {
            validated_price,
            confidence_bps: overall_confidence_bps,
            sources_used,
            sources_stale,
            sources_outlier,
            max_deviation_bps,
            deviation_flagged,
            validated_at: now,
        };

        env.storage().persistent().set(&LAST_REPORT, &report);
        let topics = (Symbol::new(&env, "price_validated"),);
        env.events().publish(
            topics,
            (report.validated_price, report.confidence_bps, report.max_deviation_bps, report.deviation_flagged),
        );

        Ok(report)
    }

    // =========================================================================
    // READ-ONLY
    // =========================================================================
    pub fn get_confidence(env: Env, source: Symbol) -> u32 {
        Self::load_confidence(&env).get(source).unwrap_or(0)
    }

    pub fn get_submission(env: Env, source: Symbol) -> Option<PriceSubmission> {
        Self::load_submissions(&env).get(source)
    }

    pub fn get_last_report(env: Env) -> Option<ValidationReport> {
        env.storage().persistent().get(&LAST_REPORT)
    }
}
