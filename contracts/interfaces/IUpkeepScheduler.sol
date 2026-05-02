// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IUpkeepScheduler {
    function setScanLimit(uint32 scanLimit) external;

    function setMaxPayoutsPerCall(uint32 maxPayoutsPerCall) external;

    function scanLimit() external view returns (uint32);

    function maxPayoutsPerCall() external view returns (uint32);
}
