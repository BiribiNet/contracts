// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/// @notice Tiered timelock for privileged calls. High-impact selectors require a longer delay.
/// @dev Proposer queues; executor runs after the elected delay. Admin can cancel. Does not wrap
/// ownership transfer; deploy beacons / governance contracts with this contract as owner, then
/// queue upgrades here.
///
/// Audit fix (High-12) vs initial `markets`-branch implementation:
/// - The single `DELAY = 24 hours` constant is replaced by `STANDARD_DELAY` and `SENSITIVE_DELAY`
///   (24 h / 48 h by default). A `sensitiveSelectors` map flags which function selectors must use
///   the longer delay. Both delays are immutable to prevent silent shortening.
contract ProtocolTimelock is AccessControl {
    /// @notice Default delay for routine ops.
    uint256 public immutable STANDARD_DELAY;
    /// @notice Longer delay for high-impact ops (e.g. beacon upgrade, engine change, fee tweaks).
    uint256 public immutable SENSITIVE_DELAY;

    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev Operation id => timestamp when executable; 0 = not queued.
    mapping(bytes32 => uint256) public queuedUntil;

    /// @notice `bytes4` function selectors that require `SENSITIVE_DELAY`.
    mapping(bytes4 => bool) public sensitiveSelectors;

    error ZeroAddress();
    error InvalidDelay();
    error AlreadyQueued();
    error NotQueued();
    error TooEarly();
    error WrongMsgValue();

    event OperationQueued(bytes32 id, address target, uint256 value, uint256 salt, uint256 executeAfter, uint256 delay);
    event OperationExecuted(bytes32 id, address target, uint256 value, uint256 salt);
    event OperationCancelled(bytes32 id);
    event SensitiveSelectorUpdated(bytes4 selector, bool isSensitive);

    constructor(address admin_, address proposer_, address executor_, uint256 standardDelay_, uint256 sensitiveDelay_) {
        if (admin_ == address(0) || proposer_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        if (standardDelay_ == 0 || sensitiveDelay_ < standardDelay_) revert InvalidDelay();

        STANDARD_DELAY = standardDelay_;
        SENSITIVE_DELAY = sensitiveDelay_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(PROPOSER_ROLE, proposer_);
        _grantRole(EXECUTOR_ROLE, executor_);

        // Preload high-impact selectors. Admin can flip more later via `setSensitiveSelector`.
        sensitiveSelectors[bytes4(keccak256("setVaultBeacon(address)"))] = true;
        sensitiveSelectors[bytes4(keccak256("setEngine(address)"))] = true;
        sensitiveSelectors[bytes4(keccak256("setInfraBps(uint256)"))] = true;
        sensitiveSelectors[bytes4(keccak256("setTreasuryBrbSplit(uint256,uint256)"))] = true;
        sensitiveSelectors[bytes4(keccak256("setSwapAssetBps(uint256)"))] = true;
    }

    function setSensitiveSelector(bytes4 selector, bool isSensitive) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sensitiveSelectors[selector] = isSensitive;
        emit SensitiveSelectorUpdated(selector, isSensitive);
    }

    function operationId(address target, uint256 value, bytes calldata data, uint256 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    /// @notice Returns the delay (standard or sensitive) that would be applied to `data`'s selector.
    function delayFor(bytes calldata data) public view returns (uint256) {
        if (data.length < 4) return STANDARD_DELAY;
        bytes4 selector = bytes4(data[0:4]);
        return sensitiveSelectors[selector] ? SENSITIVE_DELAY : STANDARD_DELAY;
    }

    function queue(address target, uint256 value, bytes calldata data, uint256 salt) external onlyRole(PROPOSER_ROLE) {
        bytes32 id = operationId(target, value, data, salt);
        if (queuedUntil[id] != 0) revert AlreadyQueued();
        uint256 delay = delayFor(data);
        uint256 eta = block.timestamp + delay;
        queuedUntil[id] = eta;
        emit OperationQueued(id, target, value, salt, eta, delay);
    }

    /// @notice `msg.value` must equal `value` so native currency is supplied at execution time (no pre-deposit on the timelock).
    function execute(address target, uint256 value, bytes calldata data, uint256 salt) external payable onlyRole(EXECUTOR_ROLE) {
        if (msg.value != value) revert WrongMsgValue();
        bytes32 id = operationId(target, value, data, salt);
        uint256 eta = queuedUntil[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly();
        queuedUntil[id] = 0;
        bytes memory dataCopy = data;
        Address.functionCallWithValue(target, dataCopy, value);
        emit OperationExecuted(id, target, value, salt);
    }

    function cancel(bytes32 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (queuedUntil[id] == 0) revert NotQueued();
        queuedUntil[id] = 0;
        emit OperationCancelled(id);
    }

    receive() external payable {}
}
