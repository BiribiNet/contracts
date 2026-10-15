// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IUpkeepForwarderAuthority } from "./interfaces/IUpkeepForwarderAuthority.sol";

/// @notice Production gate for `UpkeepScheduler.performUpkeep` — approves CRE `AutomationReceiver` (or other executors).
contract CreExecutionAuthority is AccessControl, IUpkeepForwarderAuthority {
    bytes32 public constant EXECUTOR_ADMIN_ROLE = keccak256("EXECUTOR_ADMIN_ROLE");

    mapping(address executor => bool approved) private _executorApproved;

    error ZeroAddress();

    event ExecutorApprovalUpdated(address indexed executor, bool approved);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IUpkeepForwarderAuthority
    function isApprovedAutomationForwarder(address caller) external view returns (bool) {
        return _executorApproved[caller];
    }

    function setExecutorApproved(address executor, bool approved) external onlyRole(EXECUTOR_ADMIN_ROLE) {
        if (executor == address(0)) revert ZeroAddress();
        _executorApproved[executor] = approved;
        emit ExecutorApprovalUpdated(executor, approved);
    }
}
