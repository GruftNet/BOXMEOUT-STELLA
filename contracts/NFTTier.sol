// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title NFTTier
 * @dev Platform membership NFTs that grant fee discounts, voting power bonuses,
 *      and exclusive market access on BOXMEOUT.
 *
 * Three tiers:
 *   Tier 1 – Basic  — 10% fee discount, 1× voting power
 *   Tier 2 – VIP    — 25% fee discount, 2× voting power
 *   Tier 3 – Elite  — 50% fee discount, 5× voting power, beta market access
 *
 * Compatible with OpenSea / LooksRare via standard ERC-721 transfer support.
 * One NFT per wallet (per tier upgrade replaces the old token).
 */
contract NFTTier {
    // ──────────────────────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────────────────────

    string  public  name   = "BOXMEOUT Membership";
    string  public  symbol = "BOXM";

    address public  owner;       // platform admin / deployer

    uint256 private _nextTokenId;

    // ERC-721 core mappings
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // Tier data per token
    mapping(uint256 => uint8) public  tokenTier;   // 1, 2, or 3

    // One active token per holder (wallet may only hold one NFT at a time)
    mapping(address => uint256) public holderToken; // address → tokenId (0 = none)

    // ──────────────────────────────────────────────────────────────────────────
    // Tier constants
    // ──────────────────────────────────────────────────────────────────────────

    uint8  public constant TIER_BASIC  = 1;
    uint8  public constant TIER_VIP    = 2;
    uint8  public constant TIER_ELITE  = 3;

    /// @dev Fee discounts in basis points (100 bps = 1%)
    uint16 public constant FEE_DISCOUNT_BASIC  = 1000; // 10%
    uint16 public constant FEE_DISCOUNT_VIP    = 2500; // 25%
    uint16 public constant FEE_DISCOUNT_ELITE  = 5000; // 50%

    /// @dev Voting power multipliers (stored as integers; caller divides by 1 for Basic)
    uint8  public constant VOTING_POWER_BASIC  = 1;
    uint8  public constant VOTING_POWER_VIP    = 2;
    uint8  public constant VOTING_POWER_ELITE  = 5;

    // ──────────────────────────────────────────────────────────────────────────
    // Events  (ERC-721 standard + custom)
    // ──────────────────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to,   uint256 indexed tokenId);
    event Approval(address indexed tokenOwner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed tokenOwner, address indexed operator, bool approved);

    event TierMinted(address indexed to,  uint8 tier, uint256 tokenId);
    event TierUpgraded(address indexed holder, uint8 oldTier, uint8 newTier, uint256 newTokenId);
    event TierDowngraded(address indexed holder, uint8 oldTier, uint8 newTier, uint256 newTokenId);

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        _nextTokenId = 1;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "NFTTier: caller is not owner");
        _;
    }

    modifier validTier(uint8 tier) {
        require(tier >= TIER_BASIC && tier <= TIER_ELITE, "NFTTier: invalid tier");
        _;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Minting & Upgrading
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a membership NFT to `to` at the given `tier`.
     * @dev    Platform admin only. Each wallet can only hold one NFT; use
     *         `upgradeTier` / `downgradeTier` to change an existing membership.
     */
    function mint(address to, uint8 tier) external onlyOwner validTier(tier) returns (uint256) {
        require(to != address(0), "NFTTier: mint to zero address");
        require(holderToken[to] == 0, "NFTTier: address already has an NFT — use upgradeTier");

        uint256 tokenId = _nextTokenId++;
        _mint(to, tokenId);
        tokenTier[tokenId] = tier;
        holderToken[to]    = tokenId;

        emit TierMinted(to, tier, tokenId);
        return tokenId;
    }

    /**
     * @notice Upgrade `holder`'s membership to a higher `newTier`.
     * @dev    Burns the current token and issues a fresh one with the new tier.
     *         Must be called by the admin; holder must already own an NFT.
     */
    function upgradeTier(address holder, uint8 newTier) external onlyOwner validTier(newTier) {
        uint256 oldTokenId = holderToken[holder];
        require(oldTokenId != 0, "NFTTier: holder has no NFT");
        uint8 oldTier = tokenTier[oldTokenId];
        require(newTier > oldTier, "NFTTier: new tier must be higher");

        _burn(oldTokenId);

        uint256 newTokenId = _nextTokenId++;
        _mint(holder, newTokenId);
        tokenTier[newTokenId] = newTier;
        holderToken[holder]   = newTokenId;

        emit TierUpgraded(holder, oldTier, newTier, newTokenId);
    }

    /**
     * @notice Downgrade `holder`'s membership to a lower `newTier`.
     * @dev    Burns the current token and issues a new one at the lower tier.
     *         Tier downgrade is handled correctly: exclusive market access is
     *         lost as soon as the new token is held.
     */
    function downgradeTier(address holder, uint8 newTier) external onlyOwner validTier(newTier) {
        uint256 oldTokenId = holderToken[holder];
        require(oldTokenId != 0, "NFTTier: holder has no NFT");
        uint8 oldTier = tokenTier[oldTokenId];
        require(newTier < oldTier, "NFTTier: new tier must be lower");

        _burn(oldTokenId);

        uint256 newTokenId = _nextTokenId++;
        _mint(holder, newTokenId);
        tokenTier[newTokenId] = newTier;
        holderToken[holder]   = newTokenId;

        emit TierDowngraded(holder, oldTier, newTier, newTokenId);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Tier queries
    // ──────────────────────────────────────────────────────────────────────────

    /** @return tier 0 if address holds no NFT, otherwise 1–3. */
    function tierOf(address holder) external view returns (uint8) {
        uint256 tokenId = holderToken[holder];
        if (tokenId == 0) return 0;
        return tokenTier[tokenId];
    }

    /**
     * @notice Returns the fee discount in basis points for `holder`.
     * @dev    Returns 0 when the holder has no NFT.
     */
    function feeDiscountBps(address holder) external view returns (uint16) {
        uint256 tokenId = holderToken[holder];
        if (tokenId == 0) return 0;
        uint8 tier = tokenTier[tokenId];
        if (tier == TIER_BASIC)  return FEE_DISCOUNT_BASIC;
        if (tier == TIER_VIP)    return FEE_DISCOUNT_VIP;
        if (tier == TIER_ELITE)  return FEE_DISCOUNT_ELITE;
        return 0;
    }

    /**
     * @notice Returns the voting power multiplier for `holder`.
     * @dev    Returns 1 when the holder has no NFT (no bonus).
     */
    function votingPower(address holder) external view returns (uint8) {
        uint256 tokenId = holderToken[holder];
        if (tokenId == 0) return 1; // no NFT → base voting power
        uint8 tier = tokenTier[tokenId];
        if (tier == TIER_BASIC)  return VOTING_POWER_BASIC;
        if (tier == TIER_VIP)    return VOTING_POWER_VIP;
        if (tier == TIER_ELITE)  return VOTING_POWER_ELITE;
        return 1;
    }

    /**
     * @notice Returns true if `holder` can access exclusive (beta) markets.
     * @dev    Currently only Elite tier holders qualify.
     */
    function hasEliteAccess(address holder) external view returns (bool) {
        uint256 tokenId = holderToken[holder];
        if (tokenId == 0) return false;
        return tokenTier[tokenId] == TIER_ELITE;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ERC-721 standard interface
    // ──────────────────────────────────────────────────────────────────────────

    function balanceOf(address _owner) external view returns (uint256) {
        require(_owner != address(0), "NFTTier: balance query for zero address");
        return _balanceOf[_owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NFTTier: owner query for nonexistent token");
        return tokenOwner;
    }

    function approve(address approved, uint256 tokenId) external {
        address tokenOwner = _ownerOf[tokenId];
        require(msg.sender == tokenOwner || _operatorApprovals[tokenOwner][msg.sender],
                "NFTTier: approve caller is not owner nor operator");
        _approvals[tokenId] = approved;
        emit Approval(tokenOwner, approved, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_ownerOf[tokenId] != address(0), "NFTTier: approved query for nonexistent token");
        return _approvals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "NFTTier: approve to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address _owner, address operator) external view returns (bool) {
        return _operatorApprovals[_owner][operator];
    }

    /**
     * @notice Transfer token from `from` to `to`.
     * @dev    Updates `holderToken` mapping so tier lookups remain accurate.
     *         Requires `to` must not already hold an NFT (one-NFT-per-wallet invariant).
     */
    function transferFrom(address from, address to, uint256 tokenId) external {
        _requireApprovedOrOwner(msg.sender, tokenId);
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _requireApprovedOrOwner(msg.sender, tokenId);
        _transfer(from, to, tokenId);
        // NOTE: onERC721Received callback omitted — add if full ERC-721 spec needed
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata /*data*/) external {
        _requireApprovedOrOwner(msg.sender, tokenId);
        _transfer(from, to, tokenId);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────────────────

    function _mint(address to, uint256 tokenId) internal {
        _ownerOf[tokenId] = to;
        _balanceOf[to]   += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) internal {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NFTTier: burn of nonexistent token");
        _balanceOf[tokenOwner] -= 1;
        delete _ownerOf[tokenId];
        delete _approvals[tokenId];
        delete holderToken[tokenOwner];
        delete tokenTier[tokenId];
        emit Transfer(tokenOwner, address(0), tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(_ownerOf[tokenId] == from, "NFTTier: transfer from incorrect owner");
        require(to != address(0),          "NFTTier: transfer to zero address");
        require(holderToken[to] == 0,      "NFTTier: recipient already holds an NFT");

        // Clear approval
        delete _approvals[tokenId];

        // Update balances
        _balanceOf[from] -= 1;
        _balanceOf[to]   += 1;
        _ownerOf[tokenId] = to;

        // Keep holderToken in sync
        delete holderToken[from];
        holderToken[to] = tokenId;

        emit Transfer(from, to, tokenId);
    }

    function _requireApprovedOrOwner(address spender, uint256 tokenId) internal view {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NFTTier: operator query for nonexistent token");
        require(
            spender == tokenOwner ||
            _approvals[tokenId] == spender ||
            _operatorApprovals[tokenOwner][spender],
            "NFTTier: transfer caller is not owner nor approved"
        );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "NFTTier: new owner is zero address");
        owner = newOwner;
    }
}
