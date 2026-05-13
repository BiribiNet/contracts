// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/// @notice Minimal timelock for privileged calls (e.g. `UpgradeableBeacon.upgradeTo`, registry admin).
/// @dev Proposer queues; executor runs after `DELAY`. Admin can cancel. Does not wrap ownership transfer;
/// deploy beacons / governance contracts with this contract as owner, then queue upgrades here.
contract ProtocolTimelock is AccessControl {
    uint256 public constant DELAY = 24 hours;

    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev Operation id => timestamp when executable; 0 = not queued.
    mapping(bytes32 => uint256) public queuedUntil;

    error ZeroAddress();
    error AlreadyQueued();
    error NotQueued();
    error TooEarly();
    error WrongMsgValue();

    event OperationQueued(bytes32 id, address target, uint256 value, uint256 salt, uint256 executeAfter);
    event OperationExecuted(bytes32 id, address target, uint256 value, uint256 salt);
    event OperationCancelled(bytes32 id);

    constructor(address admin_, address proposer_, address executor_) {
        if (admin_ == address(0) || proposer_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(PROPOSER_ROLE, proposer_);
        _grantRole(EXECUTOR_ROLE, executor_);
    }

    function operationId(address target, uint256 value, bytes calldata data, uint256 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    function queue(address target, uint256 value, bytes calldata data, uint256 salt) external onlyRole(PROPOSER_ROLE) {
        bytes32 id = operationId(target, value, data, salt);
        if (queuedUntil[id] != 0) revert AlreadyQueued();
        uint256 eta = block.timestamp + DELAY;
        queuedUntil[id] = eta;
        emit OperationQueued(id, target, value, salt, eta);
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
