use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, Symbol,
};

use crate::{PriceValidator, PriceValidatorClient};
use boxmeout_shared::errors::ContractError;

fn build_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env
}

fn setup(env: &Env) -> (PriceValidatorClient<'static>, Address) {
    let admin = Address::generate(env);
    let id = env.register_contract(None, PriceValidator);
    let client = PriceValidatorClient::new(env, &id);
    client.initialize(&admin);
    (client, admin)
}

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

// === submit_price

#[test]
fn submit_price_rejects_non_positive() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let source = Symbol::new(&env, "chainlink");

    let result = client.try_submit_price(&oracle, &source, &0i128);
    assert_eq!(result, Err(Ok(ContractError::InvalidPriceSubmission)));

    let result = client.try_submit_price(&oracle, &source, &-5i128);
    assert_eq!(result, Err(Ok(ContractError::InvalidPriceSubmission)));
}

#[test]
fn submit_price_overwrites_previous_value() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let source = Symbol::new(&env, "chainlink");

    client.submit_price(&oracle, &source, &100i128);
    client.submit_price(&oracle, &source, &105i128);

    let sub = client.get_submission(&source).unwrap();
    assert_eq!(sub.price, 105i128);
}

// === validate_price — no data

#[test]
fn validate_price_fails_with_no_sources() {
    let env = build_env();
    let (client, _) = setup(&env);

    let result = client.try_validate_price();
    assert_eq!(result, Err(Ok(ContractError::InsufficientPriceSources)));
}

// === validate_price — staleness

#[test]
fn validate_price_fails_when_all_sources_stale() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let source = Symbol::new(&env, "chainlink");

    set_time(&env, 1_000);
    client.submit_price(&oracle, &source, &100i128);

    // 900s staleness threshold — advance past it.
    set_time(&env, 1_000 + 901);
    let result = client.try_validate_price();
    assert_eq!(result, Err(Ok(ContractError::StalePriceData)));
}

#[test]
fn validate_price_excludes_stale_source_but_keeps_fresh_ones() {
    let env = build_env();
    let (client, _) = setup(&env);
    let chainlink = Symbol::new(&env, "chainlink");
    let uniswap = Symbol::new(&env, "uniswap");
    let oracle = Address::generate(&env);

    set_time(&env, 1_000);
    client.submit_price(&oracle, &chainlink, &100i128);

    set_time(&env, 1_000 + 901); // chainlink now stale
    client.submit_price(&oracle, &uniswap, &101i128);

    let report = client.validate_price();
    assert_eq!(report.sources_stale.len(), 1);
    assert_eq!(report.sources_stale.get(0).unwrap(), chainlink);
    assert_eq!(report.sources_used.len(), 1);
    assert_eq!(report.validated_price, 101i128);
}

// === validate_price — consensus / confidence

#[test]
fn validate_price_averages_close_sources_with_no_outliers() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let chainlink = Symbol::new(&env, "chainlink");
    let uniswap = Symbol::new(&env, "uniswap");
    let pyth = Symbol::new(&env, "pyth");

    set_time(&env, 10_000);
    client.submit_price(&oracle, &chainlink, &1_000i128);
    client.submit_price(&oracle, &uniswap, &1_005i128);
    client.submit_price(&oracle, &pyth, &995i128);

    let report = client.validate_price();
    assert_eq!(report.sources_used.len(), 3);
    assert!(report.sources_outlier.is_empty());
    assert!(report.sources_stale.is_empty());
    assert!(!report.deviation_flagged);
    // Validated price should land close to the ~1000 consensus.
    assert!((report.validated_price - 1_000).abs() <= 10);
}

#[test]
fn validate_price_flags_deviation_above_two_percent() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let chainlink = Symbol::new(&env, "chainlink");
    let uniswap = Symbol::new(&env, "uniswap");

    set_time(&env, 10_000);
    client.submit_price(&oracle, &chainlink, &1_000i128);
    client.submit_price(&oracle, &uniswap, &1_050i128); // 5% away from chainlink

    let report = client.validate_price();
    assert!(report.max_deviation_bps > 200);
    assert!(report.deviation_flagged);
}

#[test]
fn validate_price_removes_three_sigma_outlier() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let chainlink = Symbol::new(&env, "chainlink");
    let uniswap = Symbol::new(&env, "uniswap");
    let pyth = Symbol::new(&env, "pyth");

    set_time(&env, 10_000);
    client.submit_price(&oracle, &chainlink, &1_000i128);
    client.submit_price(&oracle, &uniswap, &1_002i128);
    // Wildly out of line with the other two — should be filtered as an outlier.
    client.submit_price(&oracle, &pyth, &50_000i128);

    let report = client.validate_price();
    assert_eq!(report.sources_outlier.len(), 1);
    assert_eq!(report.sources_outlier.get(0).unwrap(), pyth);
    assert_eq!(report.sources_used.len(), 2);
    // Validated price must be derived from the two agreeing sources, not the outlier.
    assert!(report.validated_price < 2_000);
}

#[test]
fn get_confidence_reflects_last_validation() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let chainlink = Symbol::new(&env, "chainlink");
    let uniswap = Symbol::new(&env, "uniswap");

    set_time(&env, 10_000);
    client.submit_price(&oracle, &chainlink, &1_000i128);
    client.submit_price(&oracle, &uniswap, &1_000i128);

    client.validate_price();

    assert!(client.get_confidence(&chainlink) > 0);
    assert!(client.get_confidence(&uniswap) > 0);
    // Unknown source has no track record yet.
    let pyth = Symbol::new(&env, "pyth");
    assert_eq!(client.get_confidence(&pyth), 0);
}

#[test]
fn get_last_report_persists_after_validation() {
    let env = build_env();
    let (client, _) = setup(&env);
    let oracle = Address::generate(&env);
    let chainlink = Symbol::new(&env, "chainlink");

    assert!(client.get_last_report().is_none());

    set_time(&env, 10_000);
    client.submit_price(&oracle, &chainlink, &1_000i128);
    let report = client.validate_price();

    let last = client.get_last_report().unwrap();
    assert_eq!(last.validated_price, report.validated_price);
    assert_eq!(last.validated_at, 10_000);
}

#[test]
fn initialize_twice_fails() {
    let env = build_env();
    let (client, admin) = setup(&env);
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
}
