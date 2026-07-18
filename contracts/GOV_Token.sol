// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title GOV_Token
 * @dev BOXMKT — BOXMEOUT governance ERC-20 token.
 *
 * Tokenomics:
 *   - Max supply: 100 000 000 BOXMKT
 *   - Minting: owner + authorised minters, capped at MAX_SUPPLY
 *   - Vesting: linear release schedule per beneficiary
 *   - Emissions: weekly mint to a designated reward pool (cooldown enforced)
 */
contract GOV_Token {
    // ── ERC-20 metadata ──────────────────────────────────────────────────────
    string  public constant name     = "BOXMEOUT Governance Token";
    string  public constant symbol   = "BOXMKT";
    uint8   public constant decimals = 18;

    uint256 public constant MAX_SUPPLY = 100_000_000 * 1e18;

    // ── Supply / balances ────────────────────────────────────────────────────
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ── Access control ───────────────────────────────────────────────────────
    address public owner;
    mapping(address => bool) public isMinter;

    // ── Vesting ──────────────────────────────────────────────────────────────
    struct VestingSchedule {
        uint256 totalAmount;
        uint256 released;
        uint64  startTime;
        uint64  duration;
        bool    revocable;
        bool    revoked;
    }
    mapping(address => VestingSchedule) public vestingSchedules;

    // ── Emissions ────────────────────────────────────────────────────────────
    address public emissionReceiver;
    uint256 public emissionPerCycle;
    uint64  public emissionCooldown;
    uint64  public lastEmissionAt;

    // ── Events ───────────────────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event MinterGranted(address indexed minter);
    event MinterRevoked(address indexed minter);
    event VestingCreated(address indexed beneficiary, uint256 totalAmount, uint64 startTime, uint64 duration);
    event VestingReleased(address indexed beneficiary, uint256 amount);
    event VestingRevoked(address indexed beneficiary, uint256 amountBurned);
    event EmissionMinted(address indexed receiver, uint256 amount);
    event EmissionParamsUpdated(address receiver, uint256 perCycle, uint64 cooldown);

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "BOXMKT: not owner");
        _;
    }
    modifier onlyMinter() {
        require(isMinter[msg.sender] || msg.sender == owner, "BOXMKT: not minter");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address _emissionReceiver, uint256 _emissionPerCycle, uint256 _initialSupply) {
        require(_emissionReceiver != address(0), "BOXMKT: zero emission receiver");
        require(_initialSupply <= MAX_SUPPLY,    "BOXMKT: exceeds max supply");

        owner            = msg.sender;
        emissionReceiver = _emissionReceiver;
        emissionPerCycle = _emissionPerCycle;
        emissionCooldown = 7 days;
        lastEmissionAt   = uint64(block.timestamp);

        if (_initialSupply > 0) _mint(msg.sender, _initialSupply);
    }

    // ── ERC-20 core ──────────────────────────────────────────────────────────
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "BOXMKT: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function increaseAllowance(address spender, uint256 added) external returns (bool) {
        allowance[msg.sender][spender] += added;
        emit Approval(msg.sender, spender, allowance[msg.sender][spender]);
        return true;
    }
    function decreaseAllowance(address spender, uint256 sub) external returns (bool) {
        uint256 cur = allowance[msg.sender][spender];
        require(cur >= sub, "BOXMKT: decreased below zero");
        allowance[msg.sender][spender] = cur - sub;
        emit Approval(msg.sender, spender, allowance[msg.sender][spender]);
        return true;
    }

    // ── Minting & burning ────────────────────────────────────────────────────
    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
        emit Minted(to, amount);
    }
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "BOXMKT: burn exceeds balance");
        balanceOf[msg.sender] -= amount;
        totalSupply           -= amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burned(msg.sender, amount);
    }
    function grantMinter(address m) external onlyOwner {
        isMinter[m] = true;
        emit MinterGranted(m);
    }
    function revokeMinter(address m) external onlyOwner {
        isMinter[m] = false;
        emit MinterRevoked(m);
    }

    // ── Vesting ──────────────────────────────────────────────────────────────
    /**
     * @notice Create a linear vesting schedule. Mints tokens into escrow.
     */
    function createVesting(
        address beneficiary,
        uint256 totalAmount,
        uint64  startTime,
        uint64  duration,
        bool    revocable
    ) external onlyOwner {
        require(beneficiary != address(0),                          "BOXMKT: zero beneficiary");
        require(duration > 0 && totalAmount > 0,                    "BOXMKT: invalid params");
        require(vestingSchedules[beneficiary].totalAmount == 0,     "BOXMKT: schedule exists");

        _mint(address(this), totalAmount); // escrowed in contract

        vestingSchedules[beneficiary] = VestingSchedule({
            totalAmount: totalAmount,
            released:    0,
            startTime:   startTime,
            duration:    duration,
            revocable:   revocable,
            revoked:     false
        });

        emit VestingCreated(beneficiary, totalAmount, startTime, duration);
    }

    /// @notice Returns tokens currently claimable by beneficiary.
    function vestedAmount(address beneficiary) public view returns (uint256) {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        if (s.totalAmount == 0 || s.revoked) return 0;

        uint64 ts = uint64(block.timestamp);
        if (ts < s.startTime) return 0;

        uint64 elapsed = ts - s.startTime;
        uint256 vested = elapsed >= s.duration
            ? s.totalAmount
            : (s.totalAmount * elapsed) / s.duration;

        return vested > s.released ? vested - s.released : 0;
    }

    /// @notice Beneficiary claims their unlocked tokens.
    function releaseVested() external {
        uint256 amount = vestedAmount(msg.sender);
        require(amount > 0, "BOXMKT: nothing to release");
        vestingSchedules[msg.sender].released += amount;
        _transfer(address(this), msg.sender, amount);
        emit VestingReleased(msg.sender, amount);
    }

    /// @notice Owner revokes a revocable schedule; unvested tokens are burned.
    function revokeVesting(address beneficiary) external onlyOwner {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        require(s.revocable && !s.revoked, "BOXMKT: not revocable or already revoked");

        // Let beneficiary claim already-vested portion
        uint256 claimable = vestedAmount(beneficiary);
        if (claimable > 0) {
            s.released += claimable;
            _transfer(address(this), beneficiary, claimable);
            emit VestingReleased(beneficiary, claimable);
        }

        uint256 unvested = s.totalAmount - s.released;
        s.revoked = true;

        if (unvested > 0) {
            balanceOf[address(this)] -= unvested;
            totalSupply              -= unvested;
            emit Transfer(address(this), address(0), unvested);
        }

        emit VestingRevoked(beneficiary, unvested);
    }

    // ── Emissions ────────────────────────────────────────────────────────────
    /// @notice Mint one emission cycle to the receiver (callable by anyone once cooldown passes).
    function emitTokens() external {
        require(
            block.timestamp >= uint256(lastEmissionAt) + uint256(emissionCooldown),
            "BOXMKT: cooldown active"
        );
        require(emissionReceiver != address(0) && emissionPerCycle > 0, "BOXMKT: emission not configured");

        lastEmissionAt = uint64(block.timestamp);
        _mint(emissionReceiver, emissionPerCycle);
        emit EmissionMinted(emissionReceiver, emissionPerCycle);
    }

    function setEmissionParams(address receiver, uint256 perCycle, uint64 cooldown) external onlyOwner {
        require(receiver != address(0) && cooldown > 0, "BOXMKT: invalid params");
        emissionReceiver = receiver;
        emissionPerCycle = perCycle;
        emissionCooldown = cooldown;
        emit EmissionParamsUpdated(receiver, perCycle, cooldown);
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BOXMKT: zero address");
        owner = newOwner;
    }

    // ── Internal ─────────────────────────────────────────────────────────────
    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0),               "BOXMKT: transfer to zero");
        require(balanceOf[from] >= amount,      "BOXMKT: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }
    function _mint(address to, uint256 amount) internal {
        require(to != address(0),                   "BOXMKT: mint to zero");
        require(totalSupply + amount <= MAX_SUPPLY, "BOXMKT: exceeds max supply");
        totalSupply   += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
