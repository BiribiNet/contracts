// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IUpkeepForwarderAuthority } from "../interfaces/IUpkeepForwarderAuthority.sol";

/// @dev Test double for `UpkeepScheduler.forwarderAuthority`.
contract MockUpkeepForwarderAuthority is IUpkeepForwarderAuthority {
    bool public approveAll;
    mapping(address => bool) public approved;

    function setApproveAll(bool on) external {
        approveAll = on;
    }

    function setApproved(address account, bool ok) external {
        approved[account] = ok;
    }

    function isApprovedAutomationForwarder(address caller) external view returns (bool) {
        if (approveAll) return true;
        return approved[caller];
    }
}
