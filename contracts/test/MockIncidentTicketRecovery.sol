// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockIncidentTicketRecovery {
    bool public fail;
    uint256 public calls;
    function setFail(bool value) external { fail = value; }
    function recoverNovember2026Tickets() external {
        require(!fail, "test cancellation failed");
        ++calls;
    }
}
