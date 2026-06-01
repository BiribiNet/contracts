// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ISideBet } from "./ISideBet.sol";

interface IUpkeepScheduler {
    function setScanLimit(uint32 scanLimit) external;

    function setMaxPayoutsPerCall(uint32 maxPayoutsPerCall) external;

    function setForwarderAuthority(address newAuthority) external;

    function forwarderAuthority() external view returns (address);

    function scanLimit() external view returns (uint32);

    function maxPayoutsPerCall() external view returns (uint32);

    function SIDE_BET() external view returns (ISideBet);

    function sideBetCursor(uint256 lane) external view returns (uint256);
}
