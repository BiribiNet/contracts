// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IUpkeepScheduler {
    function setScanLimit(uint32 scanLimit) external;

    function setMaxPayoutsPerCall(uint32 maxPayoutsPerCall) external;

    function setForwarderAuthority(address newAuthority) external;

    function setDevMode(bool enabled) external;

    function forwarderAuthority() external view returns (address);

    function devMode() external view returns (bool);

    function scanLimit() external view returns (uint32);

    function maxPayoutsPerCall() external view returns (uint32);
}
