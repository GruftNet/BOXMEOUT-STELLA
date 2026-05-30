#![no_std]
//! ============================================================
//! BOXMEOUT — MarketFactory Contract (Security-Audited)
//! ============================================================

use soroban_sdk::{contract, contractimpl, contractclient, Address, Env, Vec, Map, BytesN};

use boxmeout_shared::{
    errors::ContractError,
    types::{BetRecord, FactoryConfig, MarketConfig, MarketState, MarketStatus, FightDetails, UserPosition},
};

const MARKET_COUNT: &str    = "MARKET_COUNT";
const MARKET_MAP: &str      = "MARKET_MAP";
const ADMIN: &str           = "ADMIN";
const ORACLE_WHITELIST: &str = "ORACLE_WHITELIST";
const PAUSED: &str          = "PAUSED";
const DEFAULT_CONFIG: &str  = "DEFAULT_CONFIG";
const TREASURY: &str        = "TREASURY";
const MARKET_WASM_HASH: &str = "MARKET_WASM_HASH";
const OPEN_MARKETS: &str    = "OPEN_MARKETS";

#[contractclient(name = "MarketClient")]
pub trait MarketInterface {
    fn initialize(
        env: Env,
        factory: Address,
        market_id: u64,
        fight: FightDetails,
        config: MarketConfig,
        treasury: Address,
    ) -> Result<(), ContractError>;
    fn get_bets_by_address(env: Env, bettor: Address) -> Vec<BetRecord>;
    fn get_state(env: Env) -> Result<MarketState, ContractError>;
}

#[contract]
pub struct MarketFactory;

impl MarketFactory {
    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        let admin: Address = env
            .storage().persistent()
            .get(&ADMIN)
            .ok_or(ContractError::NotAdmin)?;
        if *caller != admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        let paused: bool = env.storage().persistent().get(&PAUSED).unwrap_or(false);
        if paused {
            return Err(ContractError::FactoryPaused);
        }
        Ok(())
    }
}

#[contractimpl]
impl MarketFactory {
    /// Initializes the factory with admin, treasury, primary oracle, and factory config.
    ///
    /// # Errors
    /// - `AlreadyInitialized`: Factory has already been initialized
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        oracle: Address,
        config: FactoryConfig,
    ) -> Result<(), ContractError> {
        // CHECKS
        if env.storage().persistent().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        // EFFECTS
        env.storage().persistent().set(&ADMIN, &admin);
        env.storage().persistent().set(&TREASURY, &treasury);

        let mut oracles: Vec<Address> = Vec::new(&env);
        oracles.push_back(oracle);
        env.storage().persistent().set(&ORACLE_WHITELIST, &oracles);

        env.storage().persistent().set(&PAUSED, &false);
        env.storage().persistent().set(&MARKET_COUNT, &0u64);
        env.storage().persistent().set(&MARKET_MAP, &Map::<u64, Address>::new(&env));

        let default_config = MarketConfig {
            min_bet: config.default_min_bet,
            max_bet: config.default_max_bet,
            fee_bps: config.default_fee_bps,
            lock_before_secs: config.default_lock_before_secs,
            resolution_window: config.default_resolution_window,
        };
        env.storage().persistent().set(&DEFAULT_CONFIG, &default_config);

        // Initialize with zero hash; admin must call update_market_wasm to set it
        let zero_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        env.storage().persistent().set(&MARKET_WASM_HASH, &zero_hash);
        env.storage().persistent().set(&OPEN_MARKETS, &Vec::<u64>::new(&env));
        Ok(())
    }

    /// Updates the Market wasm hash used for new deployments.
    /// Only admin can call this. Existing markets are unaffected.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn update_market_wasm(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&MARKET_WASM_HASH, &new_wasm_hash);
        Ok(())
    }

    /// Creates a new market for a boxing match.
    ///
    /// # Errors
    /// - `InvalidTimeRange`: Fight start time is in the past
    /// - `InvalidMarketParameters`: Fighter names are missing or market config is invalid
    /// - `BetTooLow`: min_bet is zero
    /// - `InvalidMarketParameters`: fee_bps exceeds 1000
    /// - `FactoryPaused`: Factory is paused
    /// - `WasmHashNotSet`: Admin has not yet called update_market_wasm
    pub fn create_market(
        env: Env,
        caller: Address,
        fight: FightDetails,
        config: MarketConfig,
        fee_bps: Option<u32>,
    ) -> Result<u64, ContractError> {
        // CHECKS — auth and pause guard first
        caller.require_auth();
        Self::require_not_paused(&env)?;

        if fight.scheduled_at <= env.ledger().timestamp() {
            return Err(ContractError::InvalidTimeRange);
        }
        if fight.fighter_a.len() == 0 || fight.fighter_b.len() == 0 {
            return Err(ContractError::InvalidMarketParameters);
        }

        // ── Config validation ─────────────────────────────
        if config.min_bet == 0 {
            return Err(ContractError::BetTooLow);
        }
        if config.max_bet < config.min_bet {
            return Err(ContractError::InvalidMarketParameters);
        }

        // Resolve effective fee: use override if provided (capped at 1000 bps), else config value
        let effective_fee_bps = match fee_bps {
            Some(f) => {
                if f > 1000 {
                    return Err(ContractError::InvalidMarketParameters);
                }
                f
            }
            None => {
                if config.fee_bps > 1000 {
                    return Err(ContractError::InvalidMarketParameters);
                }
                config.fee_bps
            }
        };

        let mut effective_config = config;
        effective_config.fee_bps = effective_fee_bps;

        let market_id: u64 = env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0);
        let new_count = market_id + 1;

        // ── Validate WASM hash is set ───────────────────────
        let wasm_hash: BytesN<32> = env.storage().persistent()
            .get(&MARKET_WASM_HASH)
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));
        if wasm_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(ContractError::WasmHashNotSet);
        }

        // ── Validate treasury is set ────────────────────────
        let treasury: Address = env.storage().persistent()
            .get(&TREASURY)
            .ok_or(ContractError::NotFactory)?;

        // Use market_id as salt so each deployment gets a unique address
        let salt = BytesN::from_array(&env, &{
            let mut arr = [0u8; 32];
            let id_bytes = market_id.to_be_bytes();
            arr[24..32].copy_from_slice(&id_bytes);
            arr
        });

        // INTERACTIONS — deploy then initialize
        let market_address = env
            .deployer()
            .with_address(env.current_contract_address(), salt)
            .deploy(wasm_hash);

        let market_client = MarketClient::new(&env, &market_address);
        market_client.initialize(
            &env.current_contract_address(),
            &market_id,
            &fight.clone(),
            &effective_config,
            &treasury,
        );

        let mut market_map: Map<u64, Address> =
            env.storage().persistent().get(&MARKET_MAP).unwrap_or_else(|| Map::new(&env));
        market_map.set(market_id, market_address.clone());
        env.storage().persistent().set(&MARKET_MAP, &market_map);
        env.storage().persistent().set(&MARKET_COUNT, &new_count);

        // Track as open market
        let mut open_markets: Vec<u64> =
            env.storage().persistent().get(&OPEN_MARKETS).unwrap_or_else(|| Vec::new(&env));
        open_markets.push_back(market_id);
        env.storage().persistent().set(&OPEN_MARKETS, &open_markets);

        boxmeout_shared::emit_market_created(&env, market_id, market_address, fight.match_id);
        Ok(market_id)
    }

    /// Retrieves the address of a market by ID.
    ///
    /// # Errors
    /// - `MarketNotFound`: Market ID does not exist
    pub fn get_market_address(env: Env, market_id: u64) -> Result<Address, ContractError> {
        let map: Map<u64, Address> =
            env.storage().persistent().get(&MARKET_MAP).unwrap_or_else(|| Map::new(&env));
        map.get(market_id).ok_or(ContractError::MarketNotFound)
    }

    /// Returns a paginated list of all market IDs.
    /// Capped at 100 IDs per page.
    pub fn list_market_ids(env: Env, offset: u64, limit: u32) -> Vec<u64> {
        let open: Vec<u64> =
            env.storage().persistent().get(&OPEN_MARKETS).unwrap_or_else(|| Vec::new(&env));
        let cap = if limit > 100 { 100u32 } else { limit };
        let mut result: Vec<u64> = Vec::new(&env);
        let pos = offset as u32;
        let mut fetched = 0u32;
        while (pos + fetched) < open.len() && fetched < cap {
            result.push_back(open.get(pos + fetched).unwrap());
            fetched += 1;
        }
        result
    }

    /// Lists markets with pagination, returning `(market_id, status)` pairs.
    ///
    /// - `offset`: first market ID to include (0-based)
    /// - `limit`: maximum number of results; capped at 100
    ///
    /// Markets whose state cannot be read are silently skipped.
    pub fn list_markets(env: Env, offset: u64, limit: u32) -> Vec<(u64, MarketStatus)> {
        let count: u64 = env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0);
        let map: Map<u64, Address> =
            env.storage().persistent().get(&MARKET_MAP).unwrap_or_else(|| Map::new(&env));
        let cap = if limit > 100 { 100u32 } else { limit };
        let mut result: Vec<(u64, MarketStatus)> = Vec::new(&env);

        let mut i = offset;
        let mut fetched = 0u32;
        while i < count && fetched < cap {
            if let Some(addr) = map.get(i) {
                if let Ok(Ok(state)) = MarketClient::new(&env, &addr).try_get_state() {
                        result.push_back((i, state.status));
                        fetched += 1;
                }
            }
            i += 1;
        }
        result
    }

    /// Returns the total number of markets created.
    pub fn get_market_count(env: Env) -> u64 {
        env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0)
    }

    /// Returns the IDs of all currently Open markets.
    pub fn get_open_market_ids(env: Env) -> Vec<u64> {
        env.storage().persistent().get(&OPEN_MARKETS).unwrap_or_else(|| Vec::new(&env))
    }

    /// Removes a market from the open list when it is no longer Open.
    /// Callable by admin or a whitelisted oracle after locking/resolving/cancelling.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not admin or whitelisted oracle
    /// - `MarketNotFound`: Market ID does not exist
    /// - `InvalidMarketStatus`: Market is still Open
    pub fn remove_open_market(env: Env, caller: Address, market_id: u64) -> Result<(), ContractError> {
        caller.require_auth();

        let admin: Address = env.storage().persistent().get(&ADMIN).ok_or(ContractError::NotAdmin)?;
        let oracles: Vec<Address> = env.storage().persistent().get(&ORACLE_WHITELIST).unwrap_or_else(|| Vec::new(&env));
        if caller != admin && !oracles.contains(caller.clone()) {
            return Err(ContractError::NotAdmin);
        }

        // Verify market is no longer Open
        let market_map: Map<u64, Address> =
            env.storage().persistent().get(&MARKET_MAP).unwrap_or_else(|| Map::new(&env));
        let market_address = market_map.get(market_id).ok_or(ContractError::MarketNotFound)?;
        let state = MarketClient::new(&env, &market_address)
            .try_get_state()
            .map_err(|_| ContractError::MarketNotFound)?
            .map_err(|_| ContractError::MarketNotFound)?;
        if state.status == MarketStatus::Open {
            return Err(ContractError::MarketNotOpen);
        }

        let open: Vec<u64> = env.storage().persistent().get(&OPEN_MARKETS).unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<u64> = Vec::new(&env);
        for id in open.iter() {
            if id != market_id {
                updated.push_back(id);
            }
        }
        env.storage().persistent().set(&OPEN_MARKETS, &updated);
        Ok(())
    }

    /// Adds an oracle to the whitelist.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn add_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut oracles: Vec<Address> =
            env.storage().persistent().get(&ORACLE_WHITELIST).unwrap_or_else(|| Vec::new(&env));
        if !oracles.contains(oracle.clone()) {
            oracles.push_back(oracle);
        }
        env.storage().persistent().set(&ORACLE_WHITELIST, &oracles);
        Ok(())
    }

    /// Removes an oracle from the whitelist.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `OracleNotWhitelisted`: Oracle is not in the whitelist
    pub fn remove_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let oracles: Vec<Address> =
            env.storage().persistent().get(&ORACLE_WHITELIST).unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<Address> = Vec::new(&env);
        let mut found = false;
        for o in oracles.iter() {
            if o == oracle {
                found = true;
            } else {
                updated.push_back(o);
            }
        }
        if !found {
            return Err(ContractError::OracleNotWhitelisted);
        }
        env.storage().persistent().set(&ORACLE_WHITELIST, &updated);
        Ok(())
    }

    /// Returns the list of whitelisted oracles.
    pub fn get_oracles(env: Env) -> Vec<Address> {
        env.storage().persistent().get(&ORACLE_WHITELIST).unwrap_or_else(|| Vec::new(&env))
    }

    /// Transfers admin privileges to a new address.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the current admin
    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        current_admin.require_auth();
        Self::require_admin(&env, &current_admin)?;

        let old_admin: Address = env
            .storage().persistent()
            .get(&ADMIN)
            .ok_or(ContractError::NotAdmin)?;
        env.storage().persistent().set(&ADMIN, &new_admin);
        boxmeout_shared::emit_admin_transferred(&env, old_admin, new_admin);
        Ok(())
    }

    /// Pauses the factory, preventing new market creation.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn pause_factory(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&PAUSED, &true);
        Ok(())
    }

    /// Unpauses the factory, allowing new market creation.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn unpause_factory(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&PAUSED, &false);
        Ok(())
    }

    /// Returns whether the factory is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().persistent().get(&PAUSED).unwrap_or(false)
    }

    /// Returns all market IDs currently tracked as open.
    pub fn get_all_market_ids(env: Env) -> Vec<u64> {
        env.storage().persistent().get(&OPEN_MARKETS).unwrap_or_else(|| Vec::new(&env))
    }

    /// Updates the default market configuration.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn update_default_config(
        env: Env,
        admin: Address,
        new_config: MarketConfig,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&DEFAULT_CONFIG, &new_config);
        Ok(())
    }

    /// Retrieves all unclaimed positions for a bettor across multiple markets.
    ///
    /// # Errors
    /// - `TooManyMarkets`: More than 20 market IDs provided
    /// - `MarketNotFound`: One of the market IDs does not exist
    pub fn get_user_positions_all(
        env: Env,
        bettor: Address,
        market_ids: Vec<u64>,
    ) -> Result<Vec<UserPosition>, ContractError> {
        if market_ids.len() > 20 {
            return Err(ContractError::TooManyMarkets);
        }
        let mut positions: Vec<UserPosition> = Vec::new(&env);
        let market_map: Map<u64, Address> =
            env.storage().persistent().get(&MARKET_MAP).unwrap_or_else(|| Map::new(&env));

        for market_id in market_ids.iter() {
            let market_address = market_map.get(market_id).ok_or(ContractError::MarketNotFound)?;
            let market_client = MarketClient::new(&env, &market_address);
            let bets = market_client.get_bets_by_address(&bettor);
            for bet in bets.iter() {
                if bet.amount > 0 && !bet.claimed {
                    positions.push_back(UserPosition {
                        market_id: bet.market_id,
                        side: bet.side.clone(),
                        amount: bet.amount,
                    });
                }
            }
        }
        Ok(positions)
    }
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Vec};
    use boxmeout_shared::types::{FactoryConfig, FightDetails, MarketConfig};
    use crate::{MarketFactory, MarketFactoryClient};

    fn setup() -> (Env, MarketFactoryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);
        (env, client)
    }

    fn default_config() -> FactoryConfig {
        FactoryConfig {
            default_min_bet: 1_000_000,
            default_max_bet: 100_000_000_000,
            default_fee_bps: 200,
            default_lock_before_secs: 3600,
            default_resolution_window: 86400,
        }
    }

    fn sample_fight(env: &Env) -> FightDetails {
        FightDetails {
            match_id: String::from_str(env, "FIGHT-001"),
            fighter_a: String::from_str(env, "Ali"),
            fighter_b: String::from_str(env, "Frazier"),
            weight_class: String::from_str(env, "Heavyweight"),
            scheduled_at: env.ledger().timestamp() + 86400,
            venue: String::from_str(env, "Arena"),
            title_fight: true,
        }
    }

    fn sample_market_config(_env: &Env) -> MarketConfig {
        MarketConfig {
            min_bet: 1_000_000,
            max_bet: 100_000_000_000,
            fee_bps: 200,
            lock_before_secs: 3600,
            resolution_window: 86400,
        }
    }

    fn init_factory(env: &Env, client: &MarketFactoryClient) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let oracle = Address::generate(env);
        client.initialize(&admin, &treasury, &oracle, &default_config());
    }

    // ── initialize tests ────────────────────────────────────


    #[test]
    fn test_initialize_stores_state() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let config = default_config();
        let mut expected_oracles: Vec<Address> = Vec::new(&env);
        expected_oracles.push_back(oracle.clone());

        client.initialize(&admin, &treasury, &oracle, &config);

        assert!(!client.is_paused());
        assert_eq!(client.get_oracles(), expected_oracles);
        assert_eq!(client.get_market_count(), 0u64);
    }

    #[test]
    fn test_initialize_second_call_returns_already_initialized() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let config = default_config();

        client.initialize(&admin, &treasury, &oracle, &config);

        let result = client.try_initialize(&admin, &treasury, &oracle, &config);
        assert!(result.is_err());
    }

    // ── create_market validation tests ──────────────────────

    #[test]
    fn test_create_market_fails_when_paused() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin, &treasury, &oracle, &default_config());
        client.pause_factory(&admin);

        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &sample_fight(&env), &sample_market_config(&env), &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_fight_in_past() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut fight = sample_fight(&env);
        fight.scheduled_at = env.ledger().timestamp() - 1;
        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &fight, &sample_market_config(&env), &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_fighter_name_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut fight = sample_fight(&env);
        fight.fighter_a = String::from_str(&env, "");
        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &fight, &sample_market_config(&env), &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_min_bet_zero() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.min_bet = 0;
        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &sample_fight(&env), &config, &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_max_bet_less_than_min_bet() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.max_bet = config.min_bet - 1;
        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &sample_fight(&env), &config, &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_fee_bps_exceeds_1000() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.fee_bps = 1001;
        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &sample_fight(&env), &config, &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_wasm_hash_not_set() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller, &sample_fight(&env), &sample_market_config(&env), &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_get_market_address_not_found() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let result = client.try_get_market_address(&0u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_market_ids_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&0u64, &10u32);
        assert_eq!(ids.len(), 0);
    }

    #[test]
    fn test_list_market_ids_pagination_capped_at_100() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&0u64, &200u32);
        assert!(ids.len() <= 100);
    }

    #[test]
    fn test_list_market_ids_offset_beyond_end_returns_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&999u64, &10u32);
        assert_eq!(ids.len(), 0);
    }
}