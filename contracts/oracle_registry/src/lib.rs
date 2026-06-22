#![no_std]
//! ============================================================
//! BOXMEOUT — OracleRegistry Contract
//! Manages oracle staking, slashing, and reputation scoring.
//! All fund-moving functions follow Checks-Effects-Interactions.
//! ============================================================

#[cfg(test)]
mod tests;

use soroban_sdk::{
    contract, contractimpl, token, Address, Env, Map, Vec,
};

use boxmeout_shared::errors::ContractError;

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const ADMIN: &str       = "ADMIN";
const XLM_TOKEN: &str   = "XLM_TKN";
const MIN_STAKE: &str   = "MIN_STK";
const STAKES: &str      = "STAKES";
const REPUTATIONS: &str = "REPS";
const UNSTAKE_REQ: &str = "UNSTK_REQ";
const SLASH_POOL: &str  = "SLSH_POOL";
const DIST_MKTS: &str   = "DIST_MKTS";
const ORACLE_LIST: &str = "ORACLES";

/// 30-day cooldown expressed in ledger sequences (as specified in issue).
/// In unit tests we use a short value so the test doesn't need to advance
/// the ledger by 2.5 M sequences (which would expire storage TTLs).
#[cfg(not(test))]
const UNSTAKE_COOLDOWN: u64 = 2_592_000;
#[cfg(test)]
const UNSTAKE_COOLDOWN: u64 = 10;

/// Default minimum stake: 500 XLM in stroops (500 * 10_000_000).
const DEFAULT_MIN_STAKE: i128 = 5_000_000_000;

const INITIAL_REPUTATION: i32 = 100;
const REPUTATION_ON_CORRECT: i32 = 5;
const REPUTATION_ON_SLASH: i32 = -20;
/// Reputation floor: prevents an oracle from reaching zero voting power.
const REPUTATION_FLOOR: i32 = 1;

#[contract]
pub struct OracleRegistry;

// ─── Internal helpers ─────────────────────────────────────────────────────────
impl OracleRegistry {
    fn require_admin(env: &Env) -> Result<Address, ContractError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotAdmin)?;
        admin.require_auth();
        Ok(admin)
    }

    fn load_stakes(env: &Env) -> Map<Address, i128> {
        env.storage().persistent().get(&STAKES).unwrap_or_else(|| Map::new(env))
    }

    fn save_stakes(env: &Env, m: &Map<Address, i128>) {
        env.storage().persistent().set(&STAKES, m);
    }

    fn load_reputations(env: &Env) -> Map<Address, i32> {
        env.storage().persistent().get(&REPUTATIONS).unwrap_or_else(|| Map::new(env))
    }

    fn save_reputations(env: &Env, m: &Map<Address, i32>) {
        env.storage().persistent().set(&REPUTATIONS, m);
    }

    fn load_oracle_list(env: &Env) -> Vec<Address> {
        env.storage().persistent().get(&ORACLE_LIST).unwrap_or_else(|| Vec::new(env))
    }

    fn save_oracle_list(env: &Env, v: &Vec<Address>) {
        env.storage().persistent().set(&ORACLE_LIST, v);
    }

    fn remove_from_oracle_list(env: &Env, oracle: &Address) {
        let list = Self::load_oracle_list(env);
        let mut pruned = Vec::new(env);
        for addr in list.iter() {
            if &addr != oracle {
                pruned.push_back(addr);
            }
        }
        Self::save_oracle_list(env, &pruned);
    }
}

#[contractimpl]
impl OracleRegistry {
    // =========================================================================
    // INITIALIZE
    // =========================================================================
    pub fn initialize(
        env: Env,
        admin: Address,
        xlm_token: Address,
        min_stake: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&XLM_TOKEN, &xlm_token);
        let effective_min = if min_stake > 0 { min_stake } else { DEFAULT_MIN_STAKE };
        env.storage().instance().set(&MIN_STAKE, &effective_min);
        env.storage().persistent().set(&STAKES, &Map::<Address, i128>::new(&env));
        env.storage().persistent().set(&REPUTATIONS, &Map::<Address, i32>::new(&env));
        env.storage().persistent().set(&UNSTAKE_REQ, &Map::<Address, u64>::new(&env));
        env.storage().persistent().set(&SLASH_POOL, &0i128);
        env.storage().persistent().set(&DIST_MKTS, &Vec::<u64>::new(&env));
        env.storage().persistent().set(&ORACLE_LIST, &Vec::<Address>::new(&env));
        Ok(())
    }

    // =========================================================================
    // REGISTER
    // =========================================================================
    /// Registers a new oracle with initial reputation 100.
    pub fn register(env: Env, oracle: Address) -> Result<(), ContractError> {
        oracle.require_auth();
        let mut reps = Self::load_reputations(&env);
        if reps.contains_key(oracle.clone()) {
            return Err(ContractError::OracleAlreadyWhitelisted);
        }
        reps.set(oracle.clone(), INITIAL_REPUTATION);
        Self::save_reputations(&env, &reps);
        let mut list = Self::load_oracle_list(&env);
        list.push_back(oracle);
        Self::save_oracle_list(&env, &list);
        Ok(())
    }

    // =========================================================================
    // STAKE  — fund-moving (CEI)
    // =========================================================================
    /// Locks XLM as a bond. Minimum stake enforced; oracle must be registered.
    ///
    /// # Errors
    /// - `InsufficientAmount`: amount < MIN_ORACLE_STAKE
    /// - `OracleNotWhitelisted`: oracle has not called `register` yet
    pub fn stake(env: Env, oracle: Address, amount: i128) -> Result<(), ContractError> {
        // CHECKS
        oracle.require_auth();
        let min_stake: i128 = env.storage().instance().get(&MIN_STAKE).unwrap_or(DEFAULT_MIN_STAKE);
        if amount < min_stake {
            return Err(ContractError::InsufficientAmount);
        }
        let reps = Self::load_reputations(&env);
        if !reps.contains_key(oracle.clone()) {
            return Err(ContractError::OracleNotWhitelisted);
        }
        // EFFECTS
        let mut stakes = Self::load_stakes(&env);
        let current: i128 = stakes.get(oracle.clone()).unwrap_or(0);
        stakes.set(oracle.clone(), current + amount);
        Self::save_stakes(&env, &stakes);
        // INTERACTIONS
        let xlm: Address = env.storage().instance().get(&XLM_TOKEN).ok_or(ContractError::TokenNotApproved)?;
        token::Client::new(&env, &xlm).transfer(&oracle, &env.current_contract_address(), &amount);
        Ok(())
    }

    // =========================================================================
    // UNSTAKE REQUEST
    // =========================================================================
    /// Starts the 30-day cooldown for unstaking. Must have a non-zero stake.
    pub fn unstake_request(env: Env, oracle: Address) -> Result<(), ContractError> {
        oracle.require_auth();
        let stakes = Self::load_stakes(&env);
        if stakes.get(oracle.clone()).unwrap_or(0) == 0 {
            return Err(ContractError::InsufficientBalance);
        }
        let mut reqs: Map<Address, u64> = env.storage().persistent()
            .get(&UNSTAKE_REQ).unwrap_or_else(|| Map::new(&env));
        reqs.set(oracle, env.ledger().sequence() as u64);
        env.storage().persistent().set(&UNSTAKE_REQ, &reqs);
        Ok(())
    }

    // =========================================================================
    // COMPLETE UNSTAKE  — fund-moving (CEI)
    // =========================================================================
    /// Returns the full stake to the oracle after the cooldown period elapses.
    ///
    /// # Errors
    /// - `Unauthorized`: no unstake request found
    /// - `InvalidTimeRange`: cooldown has not elapsed yet
    pub fn complete_unstake(env: Env, oracle: Address) -> Result<i128, ContractError> {
        // CHECKS
        oracle.require_auth();
        let reqs: Map<Address, u64> = env.storage().persistent()
            .get(&UNSTAKE_REQ).unwrap_or_else(|| Map::new(&env));
        let requested_at = reqs.get(oracle.clone()).ok_or(ContractError::Unauthorized)?;
        if (env.ledger().sequence() as u64) < requested_at + UNSTAKE_COOLDOWN {
            return Err(ContractError::InvalidTimeRange);
        }
        let mut stakes = Self::load_stakes(&env);
        let amount: i128 = stakes.get(oracle.clone()).unwrap_or(0);
        if amount == 0 {
            return Err(ContractError::InsufficientBalance);
        }
        // EFFECTS
        stakes.set(oracle.clone(), 0);
        Self::save_stakes(&env, &stakes);
        let mut reqs2: Map<Address, u64> = env.storage().persistent()
            .get(&UNSTAKE_REQ).unwrap_or_else(|| Map::new(&env));
        reqs2.remove(oracle.clone());
        env.storage().persistent().set(&UNSTAKE_REQ, &reqs2);
        // INTERACTIONS
        let xlm: Address = env.storage().instance().get(&XLM_TOKEN).ok_or(ContractError::TokenNotApproved)?;
        token::Client::new(&env, &xlm).transfer(&env.current_contract_address(), &oracle, &amount);
        Ok(amount)
    }

    // =========================================================================
    // SLASH  — called by Market contract after consensus
    // =========================================================================
    /// Reduces oracle's stake by `pct_bps / 10_000` and decrements reputation.
    /// Slashed funds accumulate in `slash_pool` for later distribution.
    /// No auth required — callable by Market contracts; silent on zero stake.
    /// Auto-deregisters oracles whose post-slash stake falls below the minimum.
    pub fn slash(env: Env, oracle: Address, pct_bps: u32) -> Result<(), ContractError> {
        let mut stakes = Self::load_stakes(&env);
        let current: i128 = stakes.get(oracle.clone()).unwrap_or(0);
        if current == 0 {
            return Ok(());
        }
        let slash_amount = current
            .checked_mul(pct_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);
        let new_stake = current - slash_amount;
        // EFFECTS: update stake and pool
        stakes.set(oracle.clone(), new_stake);
        Self::save_stakes(&env, &stakes);
        let pool: i128 = env.storage().persistent().get(&SLASH_POOL).unwrap_or(0);
        env.storage().persistent().set(&SLASH_POOL, &(pool + slash_amount));
        // Decrement reputation, clamped to REPUTATION_FLOOR
        let mut reps = Self::load_reputations(&env);
        let rep: i32 = reps.get(oracle.clone()).unwrap_or(INITIAL_REPUTATION);
        reps.set(oracle.clone(), (rep + REPUTATION_ON_SLASH).max(REPUTATION_FLOOR));
        Self::save_reputations(&env, &reps);
        // Auto-deregister if stake dropped below minimum
        let min_stake: i128 = env.storage().instance().get(&MIN_STAKE).unwrap_or(DEFAULT_MIN_STAKE);
        if new_stake < min_stake {
            Self::remove_from_oracle_list(&env, &oracle);
        }
        Ok(())
    }

    // =========================================================================
    // DISTRIBUTE SLASH POOL  — fund-moving (CEI)
    // =========================================================================
    /// Splits the accumulated slash pool among winning bettors proportional to
    /// their stake. Callable only once per `market_id` (idempotency guard).
    ///
    /// # Errors
    /// - `NotAdmin`: caller is not the admin
    /// - `Unauthorized`: already distributed for this market_id
    pub fn distribute_slash_pool(
        env: Env,
        market_id: u64,
        winning_bettors: Vec<(Address, i128)>,
    ) -> Result<(), ContractError> {
        // CHECKS
        Self::require_admin(&env)?;
        let dist_mkts: Vec<u64> = env.storage().persistent()
            .get(&DIST_MKTS).unwrap_or_else(|| Vec::new(&env));
        if dist_mkts.contains(market_id) {
            return Err(ContractError::Unauthorized);
        }
        let pool: i128 = env.storage().persistent().get(&SLASH_POOL).unwrap_or(0);
        // EFFECTS: mark market as distributed and clear pool before transfers
        let mut mkts = dist_mkts;
        mkts.push_back(market_id);
        env.storage().persistent().set(&DIST_MKTS, &mkts);
        if pool == 0 {
            return Ok(());
        }
        let total_stake: i128 = winning_bettors.iter().fold(0i128, |acc, (_, s)| acc + s);
        if total_stake == 0 {
            return Ok(());
        }
        env.storage().persistent().set(&SLASH_POOL, &0i128);
        // INTERACTIONS: proportional distribution
        let xlm: Address = env.storage().instance().get(&XLM_TOKEN).ok_or(ContractError::TokenNotApproved)?;
        let tkn = token::Client::new(&env, &xlm);
        for (bettor, bettor_stake) in winning_bettors.iter() {
            let share = pool
                .checked_mul(bettor_stake)
                .and_then(|v| v.checked_div(total_stake))
                .unwrap_or(0);
            if share > 0 {
                tkn.transfer(&env.current_contract_address(), &bettor, &share);
            }
        }
        Ok(())
    }

    // =========================================================================
    // REWARD CORRECT REPORT
    // =========================================================================
    /// Increments oracle reputation by 5 after a correct consensus report.
    /// Called by admin (or can be extended to be called by Market contract).
    pub fn reward_correct_report(env: Env, oracle: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut reps = Self::load_reputations(&env);
        let rep: i32 = reps.get(oracle.clone()).unwrap_or(INITIAL_REPUTATION);
        reps.set(oracle, rep + REPUTATION_ON_CORRECT);
        Self::save_reputations(&env, &reps);
        Ok(())
    }

    // =========================================================================
    // READ-ONLY
    // =========================================================================

    pub fn get_stake(env: Env, oracle: Address) -> i128 {
        Self::load_stakes(&env).get(oracle).unwrap_or(0)
    }

    pub fn get_reputation(env: Env, oracle: Address) -> i32 {
        Self::load_reputations(&env).get(oracle).unwrap_or(0)
    }

    pub fn get_oracle_list(env: Env) -> Vec<Address> {
        Self::load_oracle_list(&env)
    }

    pub fn is_registered(env: Env, oracle: Address) -> bool {
        Self::load_oracle_list(&env).contains(oracle)
    }

    pub fn get_slash_pool(env: Env) -> i128 {
        env.storage().persistent().get(&SLASH_POOL).unwrap_or(0)
    }

    pub fn get_min_stake(env: Env) -> i128 {
        env.storage().instance().get(&MIN_STAKE).unwrap_or(DEFAULT_MIN_STAKE)
    }
}
