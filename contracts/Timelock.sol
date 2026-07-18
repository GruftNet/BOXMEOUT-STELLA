// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Timelock
 * @dev 2-day timelock executor for BOXMEOUT governance proposals.
 *
 * Flow:
 *   1. Voting contract calls queue() once a proposal passes.
 *   2. After MIN_DELAY (2 days) the executor calls execute().
 *   3. Owner or proposer can cancel() before execution.
 *
 * Security:
 *   - CEI: status → Executed BEFORE external call in execute().
 *   - Each txHash executes at most once.
 *   - Execution window: MIN_DELAY … MIN_DELAY + GRACE_PERIOD (14 days).
 */
contract Timelock {
    uint256 public constant MIN_DELAY    = 2 days;
    uint256 public constant MAX_DELAY    = 30 days;
    uint256 public constant GRACE_PERIOD = 14 days;

    address public owner;
    address public proposer;
    address public executor;
    uint256 public delay;

    enum TxStatus { Pending, Queued, Executed, Cancelled }

    struct QueuedTx {
        address  target;
        uint256  value;
        bytes    data;
        uint256  eta;
        TxStatus status;
    }

    mapping(bytes32 => QueuedTx) public queuedTxs;

    event TransactionQueued(bytes32 indexed txHash, address indexed target, uint256 value, bytes data, uint256 eta);
    event TransactionExecuted(bytes32 indexed txHash, address indexed target, uint256 value, bytes data);
    event TransactionCancelled(bytes32 indexed txHash);
    event DelayUpdated(uint256 oldDelay, uint256 newDelay);
    event ProposerUpdated(address indexed oldProposer, address indexed newProposer);
    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);

    modifier onlyOwner() {
        require(msg.sender == owner, "Timelock: not owner");
        _;
    }
    modifier onlyProposer() {
        require(msg.sender == proposer || msg.sender == owner, "Timelock: not proposer");
        _;
    }
    modifier onlyExecutor() {
        require(msg.sender == executor || msg.sender == owner, "Timelock: not executor");
        _;
    }

    constructor(address _proposer, address _executor, uint256 _delay) {
        require(_proposer != address(0), "Timelock: zero proposer");
        require(_executor != address(0), "Timelock: zero executor");
        require(_delay >= MIN_DELAY && _delay <= MAX_DELAY, "Timelock: invalid delay");
        owner    = msg.sender;
        proposer = _proposer;
        executor = _executor;
        delay    = _delay;
    }

    /**
     * @notice Queue a transaction for delayed execution.
     * @param eta Desired execution timestamp (must be >= block.timestamp + delay).
     */
    function queue(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 eta
    ) external onlyProposer returns (bytes32 txHash) {
        require(target != address(0),                         "Timelock: zero target");
        require(eta >= block.timestamp + delay,               "Timelock: eta too early");
        require(eta <= block.timestamp + delay + GRACE_PERIOD,"Timelock: eta too late");

        txHash = _txHash(target, value, data, eta);
        require(queuedTxs[txHash].status != TxStatus.Queued, "Timelock: already queued");

        queuedTxs[txHash] = QueuedTx({
            target: target,
            value:  value,
            data:   data,
            eta:    eta,
            status: TxStatus.Queued
        });

        emit TransactionQueued(txHash, target, value, data, eta);
    }

    /**
     * @notice Execute a queued transaction after its delay has elapsed.
     * @dev CEI: state updated to Executed BEFORE the external call.
     */
    function execute(bytes32 txHash)
        external payable onlyExecutor
        returns (bytes memory returnData)
    {
        QueuedTx storage tx_ = queuedTxs[txHash];
        require(tx_.status == TxStatus.Queued,          "Timelock: not queued");
        require(block.timestamp >= tx_.eta,             "Timelock: delay not elapsed");
        require(block.timestamp <= tx_.eta + GRACE_PERIOD, "Timelock: tx expired");

        // CEI — update state before external call
        tx_.status = TxStatus.Executed;

        bool success;
        (success, returnData) = tx_.target.call{value: tx_.value}(tx_.data);
        require(success, "Timelock: execution failed");

        emit TransactionExecuted(txHash, tx_.target, tx_.value, tx_.data);
    }

    /// @notice Cancel a queued transaction before it executes.
    function cancel(bytes32 txHash) external onlyProposer {
        QueuedTx storage tx_ = queuedTxs[txHash];
        require(tx_.status == TxStatus.Queued, "Timelock: not queued");
        tx_.status = TxStatus.Cancelled;
        emit TransactionCancelled(txHash);
    }

    /// @notice Returns true when txHash is past its eta and ready to execute.
    function isReady(bytes32 txHash) external view returns (bool) {
        QueuedTx storage tx_ = queuedTxs[txHash];
        return tx_.status == TxStatus.Queued && block.timestamp >= tx_.eta;
    }

    /// @notice Compute the deterministic hash for a transaction tuple.
    function hashTransaction(address target, uint256 value, bytes calldata data, uint256 eta)
        external pure returns (bytes32)
    {
        return _txHash(target, value, data, eta);
    }

    // Admin
    function setDelay(uint256 newDelay) external onlyOwner {
        require(newDelay >= MIN_DELAY && newDelay <= MAX_DELAY, "Timelock: invalid delay");
        emit DelayUpdated(delay, newDelay);
        delay = newDelay;
    }
    function setProposer(address p) external onlyOwner {
        require(p != address(0), "Timelock: zero address");
        emit ProposerUpdated(proposer, p);
        proposer = p;
    }
    function setExecutor(address e) external onlyOwner {
        require(e != address(0), "Timelock: zero address");
        emit ExecutorUpdated(executor, e);
        executor = e;
    }
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Timelock: zero address");
        owner = newOwner;
    }

    receive() external payable {}

    function _txHash(address target, uint256 value, bytes memory data, uint256 eta)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(target, value, data, eta));
    }
}
