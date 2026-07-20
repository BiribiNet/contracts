// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Restricts `UpkeepScheduler.performUpkeep` to approved executors (CLA forwarders or CRE `AutomationReceiver`).
interface IUpkeepForwarderAuthority {
    function isApprovedAutomationForwarder(address caller) external view returns (bool);
}
