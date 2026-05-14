// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IUpkeepForwarderAuthority } from "../interfaces/IUpkeepForwarderAuthority.sol";

/// @dev Test double for `UpkeepScheduler.forwarderAuthority`.
contract MockUpkeepForwarderAuthority is IUpkeepForwarderAuthority {
    mapping(address => bool) public approved;

    function setApproved(address account, bool ok) external {
        approved[account] = ok;
    }

    function isApprovedAutomationForwarder(address caller) external view returns (bool) {
        return approved[caller];
    }
}
