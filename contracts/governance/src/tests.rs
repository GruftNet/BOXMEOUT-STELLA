#![cfg(test)]

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger, LedgerInfo},
    token::StellarAssetClient,
    Address, Env, Symbol,
};

use crate::{GovError, Governance, GovernanceClient, ProposalStatus, ProposalType, VoteType};

// ─── Mock Factory ─────────────────────────────────────────────────────────────

#[contract]
struct MockFactory;

#[contractimpl]
impl MockFactory {
    pub fn set_fee_bps(env: Env, fee_bps: u32) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "fee"), &fee_bps);
    }

    pub fn get_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "fee"))
            .unwrap_or(0)
    }

    pub fn update_token_list(env: Env, token: Address, add: bool) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tok"), &(token, add));
    }

    pub fn get_last_token_op(env: Env) -> Option<(Address, bool)> {
        env.storage().instance().get(&Symbol::new(&env, "tok"))
    }
}

// ─── Mock Treasury ────────────────────────────────────────────────────────────

#[contract]
struct MockTreasury;

#[contractimpl]
impl MockTreasury {
    pub fn set_max_discount(env: Env, bps: u32) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "disc"), &bps);
    }

    pub fn get_max_discount(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "disc"))
            .unwrap_or(0)
    }
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const VOTING_PERIOD: u32 = 120_960;
const TIMELOCK_PERIOD: u32 = 34_560;
const VETO_COOLDOWN: u32 = 120_960;

/// Base quorum supply: 1_000 XLM in stroops.
/// A voter with >= 50 XLM satisfies the 5% threshold.
const QUORUM_SUPPLY: i128 = 10_000_000_000;

struct Setup {
    env: Env,
    admin: Address,
    factory: Address,
    treasury: Address,
    xlm: Address,
    gov: GovernanceClient<'static>,
}

fn default_ledger_info(seq: u32, ts: u64) -> LedgerInfo {
    LedgerInfo {
        timestamp: ts,
        protocol_version: 20,
        sequence_number: seq,
        network_id: Default::default(),
        base_reserve: 1,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_311_520,
    }
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(default_ledger_info(1000, 5000));

    let admin = Address::generate(&env);
    let factory = env.register_contract(None, MockFactory);
    let treasury = env.register_contract(None, MockTreasury);
    let xlm = env.register_stellar_asset_contract(admin.clone());

    let gov_id = env.register_contract(None, Governance);
    let gov = GovernanceClient::new(&env, &gov_id);

    gov.initialize(&admin, &factory, &treasury, &xlm, &QUORUM_SUPPLY);

    Setup {
        env,
        admin,
        factory,
        treasury,
        xlm,
        gov,
    }
}

fn advance_ledger(env: &Env, ledgers: u32) {
    let info = env.ledger().get();
    env.ledger().set(default_ledger_info(
        info.sequence_number + ledgers,
        info.timestamp + (ledgers as u64) * 5,
    ));
}

// ─── Initialisation ───────────────────────────────────────────────────────────

#[test]
fn test_initialize_stores_state() {
    let s = setup();
    assert_eq!(s.gov.proposal_count(), 0);
}

#[test]
fn test_initialize_second_call_returns_already_initialized() {
    let s = setup();
    let result = s
        .gov
        .try_initialize(&s.admin, &s.factory, &s.treasury, &s.xlm, &QUORUM_SUPPLY);
    assert_eq!(result, Err(Ok(GovError::AlreadyInitialized)));
}

// ─── Full Happy Path: FeeRate → factory.set_fee_bps ──────────────────────────

#[test]
fn test_full_happy_path_fee_rate_execute_calls_factory() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);

    // 600 XLM → satisfies 5% of 1000 XLM quorum supply
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(300));
    assert_eq!(pid, 0);

    let record = s.gov.vote(&voter, &pid, &VoteType::For);
    assert_eq!(record.power, 6_000_000_000i128);

    advance_ledger(&s.env, VOTING_PERIOD + 1);
    let status = s.gov.finalize(&pid);
    assert_eq!(status, ProposalStatus::Passed);

    let proposal = s.gov.get_proposal(&pid);
    assert_eq!(proposal.status, ProposalStatus::Passed);
    assert!(proposal.execute_after > 0);

    // Cannot execute before timelock
    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::TimelockNotExpired))
    );

    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);
    s.gov.execute(&pid);

    let after = s.gov.get_proposal(&pid);
    assert_eq!(after.status, ProposalStatus::Executed);

    let mock_factory = MockFactoryClient::new(&s.env, &s.factory);
    assert_eq!(mock_factory.get_fee_bps(), 300);
}

// ─── MaxDiscountRate → treasury.set_max_discount ─────────────────────────────

#[test]
fn test_execute_max_discount_rate_calls_treasury() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s
        .gov
        .create_proposal(&proposer, &ProposalType::MaxDiscountRate(500));

    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);
    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);
    s.gov.execute(&pid);

    let mock_treasury = MockTreasuryClient::new(&s.env, &s.treasury);
    assert_eq!(mock_treasury.get_max_discount(), 500);
}

// ─── AddToken → factory.update_token_list(token, true) ───────────────────────

#[test]
fn test_execute_add_token_calls_factory() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    let new_token = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s
        .gov
        .create_proposal(&proposer, &ProposalType::AddToken(new_token.clone()));

    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);
    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);
    s.gov.execute(&pid);

    let mock_factory = MockFactoryClient::new(&s.env, &s.factory);
    let (tok, add) = mock_factory.get_last_token_op().unwrap();
    assert_eq!(tok, new_token);
    assert!(add);
}

// ─── RemoveToken → factory.update_token_list(token, false) ───────────────────

#[test]
fn test_execute_remove_token_calls_factory() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    let old_token = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s
        .gov
        .create_proposal(&proposer, &ProposalType::RemoveToken(old_token.clone()));

    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);
    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);
    s.gov.execute(&pid);

    let mock_factory = MockFactoryClient::new(&s.env, &s.factory);
    let (tok, add) = mock_factory.get_last_token_op().unwrap();
    assert_eq!(tok, old_token);
    assert!(!add);
}

// ─── Failed Quorum ────────────────────────────────────────────────────────────

#[test]
fn test_failed_quorum_marks_proposal_failed() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);

    // 0.1 XLM → total_votes * 20 = 20_000_000 << 10_000_000_000 → no quorum
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &1_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(100));
    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);

    let status = s.gov.finalize(&pid);
    assert_eq!(status, ProposalStatus::Failed);

    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::ProposalNotPassed))
    );
}

// ─── Failed Threshold (against wins) ─────────────────────────────────────────

#[test]
fn test_failed_threshold_when_against_wins() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter_for = Address::generate(&s.env);
    let voter_against = Address::generate(&s.env);

    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter_for, &2_000_000_000i128);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter_against, &4_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(100));
    s.gov.vote(&voter_for, &pid, &VoteType::For);
    s.gov.vote(&voter_against, &pid, &VoteType::Against);
    advance_ledger(&s.env, VOTING_PERIOD + 1);

    // quorum: (2B + 4B) * 20 = 120B >= 10B ✓; but against > for → Failed
    let status = s.gov.finalize(&pid);
    assert_eq!(status, ProposalStatus::Failed);
}

// ─── Veto Before Voting Ends ──────────────────────────────────────────────────

#[test]
fn test_veto_before_voting_ends_sets_vetoed_status() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    s.gov.veto(&s.admin, &pid);

    let proposal = s.gov.get_proposal(&pid);
    assert_eq!(proposal.status, ProposalStatus::Vetoed);
}

#[test]
fn test_veto_after_voting_ends_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    advance_ledger(&s.env, VOTING_PERIOD + 1);

    assert_eq!(
        s.gov.try_veto(&s.admin, &pid),
        Err(Ok(GovError::VotingPeriodEnded))
    );
}

#[test]
fn test_non_admin_veto_returns_not_admin() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let interloper = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    assert_eq!(
        s.gov.try_veto(&interloper, &pid),
        Err(Ok(GovError::NotAdmin))
    );
}

// ─── Double-Vote Prevention ───────────────────────────────────────────────────

#[test]
fn test_double_vote_returns_already_voted() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &1_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(100));
    s.gov.vote(&voter, &pid, &VoteType::For);

    assert_eq!(
        s.gov.try_vote(&voter, &pid, &VoteType::Against),
        Err(Ok(GovError::AlreadyVoted))
    );
}

// ─── Execute Before Timelock ──────────────────────────────────────────────────

#[test]
fn test_execute_before_timelock_expires_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(300));
    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);

    advance_ledger(&s.env, 1);

    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::TimelockNotExpired))
    );
}

// ─── Veto Cooldown ────────────────────────────────────────────────────────────

#[test]
fn test_veto_cooldown_blocks_same_type_within_7_days() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    s.gov.veto(&s.admin, &pid);

    assert_eq!(
        s.gov
            .try_create_proposal(&proposer, &ProposalType::FeeRate(300)),
        Err(Ok(GovError::VetoCooldownActive))
    );
}

#[test]
fn test_veto_cooldown_expires_after_7_days() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    s.gov.veto(&s.admin, &pid);

    advance_ledger(&s.env, VETO_COOLDOWN + 1);

    // Can create a new FeeRate proposal after cooldown
    let res = s
        .gov
        .try_create_proposal(&proposer, &ProposalType::FeeRate(300));
    assert!(res.is_ok());
}

#[test]
fn test_veto_cooldown_does_not_affect_different_proposal_type() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    s.gov.veto(&s.admin, &pid);

    // MaxDiscountRate is a different type — should succeed
    let res = s
        .gov
        .try_create_proposal(&proposer, &ProposalType::MaxDiscountRate(300));
    assert!(res.is_ok());
}

// ─── Snapshot Voting ──────────────────────────────────────────────────────────

#[test]
fn test_snapshot_power_is_captured_at_vote_time_and_immutable() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);

    let xlm_client = StellarAssetClient::new(&s.env, &s.xlm);
    xlm_client.mint(&voter, &1_000_000_000i128); // 100 XLM

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    // Vote — power snapshot taken here: 100 XLM = 1_000_000_000 stroops
    s.gov.vote(&voter, &pid, &VoteType::For);

    let record_before = s.gov.get_vote(&pid, &voter).unwrap();
    assert_eq!(record_before.power, 1_000_000_000i128);

    // Change voter's balance significantly AFTER voting
    xlm_client.mint(&voter, &9_000_000_000i128); // voter now has 1000 XLM

    // Stored vote record must still reflect the snapshot balance, not current balance
    let record_after = s.gov.get_vote(&pid, &voter).unwrap();
    assert_eq!(
        record_after.power,
        1_000_000_000i128,
        "voting power must not change after balance update"
    );

    let proposal = s.gov.get_proposal(&pid);
    assert_eq!(proposal.votes_for, 1_000_000_000i128);
}

// ─── Vote After Voting Period ─────────────────────────────────────────────────

#[test]
fn test_vote_after_voting_period_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &1_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    advance_ledger(&s.env, VOTING_PERIOD + 1);

    assert_eq!(
        s.gov.try_vote(&voter, &pid, &VoteType::For),
        Err(Ok(GovError::VotingPeriodEnded))
    );
}

// ─── Finalize Before Voting Period ───────────────────────────────────────────

#[test]
fn test_finalize_before_voting_period_ends_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    advance_ledger(&s.env, 1);

    assert_eq!(
        s.gov.try_finalize(&pid),
        Err(Ok(GovError::VotingPeriodNotEnded))
    );
}

// ─── Execute on Non-Passed Proposal ──────────────────────────────────────────

#[test]
fn test_execute_on_failed_proposal_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &100_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);
    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);

    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::ProposalNotPassed))
    );
}

#[test]
fn test_execute_on_active_proposal_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));

    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::ProposalNotPassed))
    );
}

// ─── Get Non-Existent Proposal ────────────────────────────────────────────────

#[test]
fn test_get_nonexistent_proposal_returns_not_found() {
    let s = setup();
    assert_eq!(
        s.gov.try_get_proposal(&999u64),
        Err(Ok(GovError::ProposalNotFound))
    );
}

// ─── Proposal Count ───────────────────────────────────────────────────────────

#[test]
fn test_proposal_count_increments() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    assert_eq!(s.gov.proposal_count(), 0);
    s.gov.create_proposal(&proposer, &ProposalType::FeeRate(200));
    assert_eq!(s.gov.proposal_count(), 1);
    s.gov
        .create_proposal(&proposer, &ProposalType::MaxDiscountRate(100));
    assert_eq!(s.gov.proposal_count(), 2);
}

// ─── Execute Already Executed Proposal ───────────────────────────────────────

#[test]
fn test_execute_already_executed_returns_error() {
    let s = setup();
    let proposer = Address::generate(&s.env);
    let voter = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&voter, &6_000_000_000i128);

    let pid = s.gov.create_proposal(&proposer, &ProposalType::FeeRate(300));
    s.gov.vote(&voter, &pid, &VoteType::For);
    advance_ledger(&s.env, VOTING_PERIOD + 1);
    s.gov.finalize(&pid);
    advance_ledger(&s.env, TIMELOCK_PERIOD + 1);
    s.gov.execute(&pid);

    assert_eq!(
        s.gov.try_execute(&pid),
        Err(Ok(GovError::ProposalNotPassed))
    );
}
