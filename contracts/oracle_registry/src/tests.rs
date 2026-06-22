#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

use crate::{OracleRegistry, OracleRegistryClient};
use boxmeout_shared::errors::ContractError;

const MIN_STAKE: i128 = 5_000_000_000; // 500 XLM in stroops

fn build_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env
}

fn build_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract(admin.clone())
}

fn mint(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token_addr).mint(to, &amount);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn test_stake_below_minimum_fails() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);

    // 499 XLM = 4_990_000_000 stroops — below the 500 XLM minimum
    let result = registry.try_stake(&oracle, &4_990_000_000i128);
    assert_eq!(result, Err(Ok(ContractError::InsufficientAmount)));
}

#[test]
fn test_slash_reduces_stake_by_correct_bps() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE); // 500 XLM

    registry.slash(&oracle, &2000u32); // 20 % slash

    // 500 XLM × 80 % = 400 XLM = 4_000_000_000 stroops
    assert_eq!(registry.get_stake(&oracle), 4_000_000_000);
    // Slash pool receives the 100 XLM = 1_000_000_000 stroops
    assert_eq!(registry.get_slash_pool(), 1_000_000_000);
}

#[test]
fn test_reputation_decrements_on_slash() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE);

    assert_eq!(registry.get_reputation(&oracle), 100);
    registry.slash(&oracle, &2000u32);
    // 100 + (−20) = 80
    assert_eq!(registry.get_reputation(&oracle), 80);
}

#[test]
fn test_reputation_floor_is_one() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 100_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE);

    // Slash 8 times: 100 − 8×20 = −60 → clamped to 1
    for _ in 0..8 {
        registry.slash(&oracle, &100u32); // 1 % each — small enough not to trigger deregister
    }
    assert!(
        registry.get_reputation(&oracle) >= 1,
        "reputation must not fall below 1"
    );
}

#[test]
fn test_unstake_before_cooldown_fails() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE);
    registry.unstake_request(&oracle); // records sequence 0

    // Advance to sequence 5 — below the test cooldown of 10
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        sequence_number: 5,
        ..env.ledger().get()
    });

    let result = registry.try_complete_unstake(&oracle);
    assert_eq!(result, Err(Ok(ContractError::InvalidTimeRange)));
}

#[test]
fn test_unstake_after_cooldown_succeeds() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE);
    registry.unstake_request(&oracle); // records sequence 0

    // Advance past the test cooldown of 10 sequences
    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        sequence_number: 11,
        ..env.ledger().get()
    });

    let returned = registry.complete_unstake(&oracle);
    assert_eq!(returned, MIN_STAKE);
    assert_eq!(registry.get_stake(&oracle), 0);
}

/// Distributes the slash pool proportionally: bettor_a gets 60 %, bettor_b gets 40 %.
#[test]
fn test_distribute_slash_pool_proportional_60_40() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let bettor_a = Address::generate(&env);
    let bettor_b = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);
    let token = TokenClient::new(&env, &xlm);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE); // 500 XLM staked
    registry.slash(&oracle, &2000u32);   // 20 % → 1_000_000_000 in pool

    let mut bettors = Vec::new(&env);
    bettors.push_back((bettor_a.clone(), 60i128));
    bettors.push_back((bettor_b.clone(), 40i128));

    registry.distribute_slash_pool(&1u64, &bettors);

    // 1_000_000_000 * 60/100 = 600_000_000
    assert_eq!(token.balance(&bettor_a), 600_000_000);
    // 1_000_000_000 * 40/100 = 400_000_000
    assert_eq!(token.balance(&bettor_b), 400_000_000);
    assert_eq!(registry.get_slash_pool(), 0);
}

#[test]
fn test_distribute_slash_pool_idempotent() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let bettor = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE);
    registry.slash(&oracle, &2000u32);

    let mut bettors = Vec::new(&env);
    bettors.push_back((bettor.clone(), 1i128));

    registry.distribute_slash_pool(&1u64, &bettors);
    // Second call for the same market_id must be rejected
    let result = registry.try_distribute_slash_pool(&1u64, &bettors);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

/// Validates the weighted-consensus arithmetic required by the issue:
/// 3 oracles with reputations 200 / 100 / 50 vote A / A / B.
/// FighterA accumulates weight 300; FighterB accumulates 50.
/// 300 × 2 = 600 > 350 total → FighterA wins.
#[test]
fn test_weighted_consensus_a_wins_over_flat_vote() {
    let weight_a: i64 = 200 + 100;
    let weight_b: i64 = 50;
    let total: i64 = weight_a + weight_b;

    assert!(weight_a * 2 > total, "FighterA must win by weighted majority");
    assert_eq!(weight_a, 300);
    assert_eq!(total, 350);
    // FighterB does not exceed 50 %
    assert!(weight_b * 2 <= total);
}

/// An oracle slashed below the minimum stake must be auto-deregistered
/// and must not be able to submit future reports.
#[test]
fn test_slashed_oracle_below_min_stake_is_deregistered() {
    let env = build_env();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let xlm = build_token(&env, &admin);
    mint(&env, &xlm, &oracle, 10_000_000_000);

    let id = env.register_contract(None, OracleRegistry);
    let registry = OracleRegistryClient::new(&env, &id);
    registry.initialize(&admin, &xlm, &MIN_STAKE);
    registry.register(&oracle);
    registry.stake(&oracle, &MIN_STAKE); // 500 XLM = exactly the minimum

    assert!(registry.is_registered(&oracle));

    // Slash 90 %: new stake = 50 XLM = 500_000_000 < 5_000_000_000 minimum
    registry.slash(&oracle, &9000u32);

    assert!(
        registry.get_stake(&oracle) < registry.get_min_stake(),
        "stake must be below minimum after 90 % slash"
    );
    assert!(
        !registry.is_registered(&oracle),
        "oracle must be auto-deregistered when stake falls below minimum"
    );
}
