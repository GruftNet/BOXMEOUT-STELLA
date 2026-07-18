// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./GOV_Token.sol";
import "./Timelock.sol";

/**
 * @title Voting
 * @dev veToken vote-escrow governance for BOXMEOUT.
 *
 * ## veToken mechanics
 *   - Holders lock BOXMKT for 1–4 years.
 *   - Voting power = lockedAmount * lockYears  (1x–4x multiplier).
 *   - Locked tokens cannot be transferred until the lock expires.
 *   - Expired locks can be withdrawn at any time.
 *
 * ## Proposal lifecycle
 *   - Any holder with >= PROPOSAL_THRESHOLD veTokens can submit a proposal.
 *   - Voting period: 5 days minimum (configurable).
 *   - Quorum: 4% of total veToken supply must vote YES.
 *   - A passing proposal is queued in the Timelock; executed after 2-day delay.
 *   - All votes are stored immutably on-chain for audit purposes.
 *
 * ## Security
 *   - require_auth equivalent: only lock owner can vote / unlock.
 *   - CEI in queueProposal: status updated before Timelock.queue() call.
 */
contract Voting {
    // ── Constants ────────────────────────────────────────────────────────────
    uint256 public constant MIN_LOCK_SECS    = 365 days;   // 1 year
    uint256 public constant MAX_LOCK_SECS    = 4 * 365 days; // 4 years
    uint256 public constant VOTING_PERIOD    = 5 days;
    uint256 public constant PROPOSAL_THRESHOLD = 1_000 * 1e18; // 1 000 BOXMKT locked
    uint256 public constant QUORUM_BPS       = 400;        // 4% of total veSupply

    // ── State ────────────────────────────────────────────────────────────────
    GOV_Token public govToken;
    Timelock  public timelock;
    address   public owner;

    // veToken tracking
    struct Lock {
        uint256 amount;       // BOXMKT locked
        uint64  unlockTime;   // unix timestamp
        uint256 votingPower;  // cached at lock time: amount * years
    }
    mapping(address => Lock) public locks;
    uint256 public totalVeSupply; // sum of all active voting powers

    // Proposals
    enum ProposalStatus { Pending, Active, Passed, Failed, Queued, Executed, Cancelled }

    struct Proposal {
        uint256  id;
        address  proposer;
        string   description;
        address  target;       // contract to call on execution
        bytes    callData;     // encoded function call
        uint256  value;        // ETH to forward
        uint64   startTime;
        uint64   endTime;
        uint256  yesVotes;
        uint256  noVotes;
        ProposalStatus status;
        bytes32  timelockTxHash; // set after queueing
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    // Vote record: proposalId → voter → voted
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // Historical vote log for audit trail
    struct VoteRecord {
        uint256 proposalId;
        address voter;
        bool    support;
        uint256 weight;
        uint64  timestamp;
    }
    VoteRecord[] public voteHistory;

    // ── Events ───────────────────────────────────────────────────────────────
    event Locked(address indexed user, uint256 amount, uint64 unlockTime, uint256 votingPower);
    event Unlocked(address indexed user, uint256 amount);
    event ProposalCreated(uint256 indexed id, address indexed proposer, string description, uint64 endTime);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed id, bytes32 timelockTxHash, uint256 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id);

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Voting: not owner");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address _govToken, address _timelock) {
        require(_govToken  != address(0), "Voting: zero govToken");
        require(_timelock  != address(0), "Voting: zero timelock");
        owner     = msg.sender;
        govToken  = GOV_Token(_govToken);
        timelock  = Timelock(_timelock);
    }

    // ── veToken: lock / unlock ────────────────────────────────────────────────
    /**
     * @notice Lock `amount` BOXMKT for `lockSecs` seconds (1–4 years).
     * @dev    Caller must approve this contract to spend `amount` BOXMKT first.
     */
    function lock(uint256 amount, uint256 lockSecs) external {
        require(amount > 0,                                    "Voting: zero amount");
        require(lockSecs >= MIN_LOCK_SECS,                     "Voting: lock too short");
        require(lockSecs <= MAX_LOCK_SECS,                     "Voting: lock too long");
        require(locks[msg.sender].amount == 0,                 "Voting: already locked — use extend");

        govToken.transferFrom(msg.sender, address(this), amount);

        // Voting power: amount * (lockYears) where lockYears = lockSecs / 1 year (1–4)
        uint256 lockYears  = lockSecs / 365 days; // integer 1–4
        if (lockYears == 0) lockYears = 1;
        uint256 votingPower = amount * lockYears;

        uint64 unlockTime = uint64(block.timestamp + lockSecs);
        locks[msg.sender] = Lock({ amount: amount, unlockTime: unlockTime, votingPower: votingPower });
        totalVeSupply += votingPower;

        emit Locked(msg.sender, amount, unlockTime, votingPower);
    }

    /**
     * @notice Extend an existing lock to increase voting power.
     * @dev    New `lockSecs` must result in an unlockTime later than the current one.
     */
    function extendLock(uint256 lockSecs) external {
        Lock storage l = locks[msg.sender];
        require(l.amount > 0,                          "Voting: no existing lock");
        require(lockSecs >= MIN_LOCK_SECS && lockSecs <= MAX_LOCK_SECS, "Voting: invalid duration");

        uint64 newUnlock = uint64(block.timestamp + lockSecs);
        require(newUnlock > l.unlockTime,              "Voting: must be later than current unlock");

        uint256 lockYears = lockSecs / 365 days;
        if (lockYears == 0) lockYears = 1;
        uint256 newPower = l.amount * lockYears;

        totalVeSupply  = totalVeSupply - l.votingPower + newPower;
        l.unlockTime   = newUnlock;
        l.votingPower  = newPower;

        emit Locked(msg.sender, l.amount, newUnlock, newPower);
    }

    /**
     * @notice Withdraw locked tokens after the lock period expires.
     */
    function unlock() external {
        Lock storage l = locks[msg.sender];
        require(l.amount > 0,                              "Voting: nothing locked");
        require(block.timestamp >= l.unlockTime,           "Voting: lock not expired");

        uint256 amount = l.amount;
        totalVeSupply -= l.votingPower;
        delete locks[msg.sender];

        govToken.transfer(msg.sender, amount);
        emit Unlocked(msg.sender, amount);
    }

    // ── Proposals ────────────────────────────────────────────────────────────
    /**
     * @notice Submit a governance proposal.
     * @param description  Human-readable description
     * @param target       Contract address to call on execution
     * @param callData     ABI-encoded function call
     * @param value        ETH to forward on execution
     */
    function propose(
        string calldata description,
        address target,
        bytes   calldata callData,
        uint256 value
    ) external returns (uint256 id) {
        require(locks[msg.sender].votingPower >= PROPOSAL_THRESHOLD, "Voting: insufficient voting power");
        require(target != address(0), "Voting: zero target");

        id = ++proposalCount;
        uint64 startTime = uint64(block.timestamp);
        uint64 endTime   = uint64(block.timestamp + VOTING_PERIOD);

        proposals[id] = Proposal({
            id:              id,
            proposer:        msg.sender,
            description:     description,
            target:          target,
            callData:        callData,
            value:           value,
            startTime:       startTime,
            endTime:         endTime,
            yesVotes:        0,
            noVotes:         0,
            status:          ProposalStatus.Active,
            timelockTxHash:  bytes32(0)
        });

        emit ProposalCreated(id, msg.sender, description, endTime);
    }

    /**
     * @notice Cast a vote on an active proposal.
     * @param proposalId  Proposal to vote on
     * @param support     true = YES, false = NO
     */
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        require(p.status == ProposalStatus.Active,          "Voting: proposal not active");
        require(block.timestamp <= p.endTime,               "Voting: voting period ended");
        require(!hasVoted[proposalId][msg.sender],          "Voting: already voted");
        require(locks[msg.sender].amount > 0,               "Voting: no locked tokens");

        uint256 weight = locks[msg.sender].votingPower;
        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            p.yesVotes += weight;
        } else {
            p.noVotes += weight;
        }

        // Immutable audit trail
        voteHistory.push(VoteRecord({
            proposalId: proposalId,
            voter:      msg.sender,
            support:    support,
            weight:     weight,
            timestamp:  uint64(block.timestamp)
        }));

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @notice Finalise a proposal after its voting period and queue it if it passed.
     * @dev    Anyone can call once endTime has elapsed.
     *         CEI: status updated BEFORE calling timelock.queue().
     */
    function finalise(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.status == ProposalStatus.Active,   "Voting: not active");
        require(block.timestamp > p.endTime,         "Voting: period not ended");

        // Quorum check: yesVotes must represent >= QUORUM_BPS of total veSupply
        bool quorumMet = totalVeSupply == 0
            ? false
            : (p.yesVotes * 10_000) / totalVeSupply >= QUORUM_BPS;

        if (!quorumMet || p.yesVotes <= p.noVotes) {
            p.status = ProposalStatus.Failed;
            return;
        }

        // CEI: mark Queued before external call
        p.status = ProposalStatus.Queued;

        uint256 eta = block.timestamp + timelock.delay();
        bytes32 txHash = timelock.queue(p.target, p.value, p.callData, eta);
        p.timelockTxHash = txHash;

        emit ProposalQueued(proposalId, txHash, eta);
    }

    /**
     * @notice Execute a queued proposal via the Timelock.
     */
    function execute(uint256 proposalId) external payable {
        Proposal storage p = proposals[proposalId];
        require(p.status == ProposalStatus.Queued, "Voting: not queued");

        p.status = ProposalStatus.Executed;
        timelock.execute{value: p.value}(p.timelockTxHash);

        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Cancel an active or queued proposal. Proposer or owner only.
     */
    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(
            msg.sender == p.proposer || msg.sender == owner,
            "Voting: not proposer or owner"
        );
        require(
            p.status == ProposalStatus.Active || p.status == ProposalStatus.Queued,
            "Voting: cannot cancel"
        );

        if (p.status == ProposalStatus.Queued) {
            timelock.cancel(p.timelockTxHash);
        }

        p.status = ProposalStatus.Cancelled;
        emit ProposalCancelled(proposalId);
    }

    // ── View helpers ─────────────────────────────────────────────────────────
    /// @notice Returns the voting power of `user` (0 if no active lock).
    function votingPowerOf(address user) external view returns (uint256) {
        return locks[user].votingPower;
    }

    /// @notice Returns the length of the immutable vote history array.
    function voteHistoryLength() external view returns (uint256) {
        return voteHistory.length;
    }

    /// @notice Returns a slice of vote records [from, to).
    function getVoteHistory(uint256 from, uint256 to)
        external view
        returns (VoteRecord[] memory records)
    {
        require(to <= voteHistory.length && from <= to, "Voting: invalid range");
        records = new VoteRecord[](to - from);
        for (uint256 i = from; i < to; i++) {
            records[i - from] = voteHistory[i];
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Voting: zero address");
        owner = newOwner;
    }
}
