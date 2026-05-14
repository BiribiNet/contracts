// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Restricts `UpkeepScheduler.performUpkeep` to Chainlink Automation forwarders (see Chainlink "forwarder pattern").
interface IUpkeepForwarderAuthority {
    function isApprovedAutomationForwarder(address caller) external view returns (bool);
}
