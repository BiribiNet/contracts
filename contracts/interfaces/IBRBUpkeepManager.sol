// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title IBRBUpkeepManager
 * @dev Roulette delegates forwarder checks and payout capacity to the manager. Forwarders cannot be set arbitrarily.
 */
interface IBRBUpkeepManager {
    /// @dev True if `forwarder` may call {RouletteClean.performUpkeep} (roulette upkeeps).
    function isAuthorizedForwarder(address forwarder) external view returns (bool);

    /// @dev True if `forwarder` may call {BRBUpkeepManager.performUpkeep} for StakedBRB cleaning.
    function isStakedBrbCleaningForwarder(address forwarder) external view returns (bool);

    function maxSupportedBets() external view returns (uint256);

    function registeredPayoutUpkeepCount() external view returns (uint256);

    function batchSize() external pure returns (uint256);

    function upkeepGasLimit() external pure returns (uint32);

    function boundarySyncGasLimit() external pure returns (uint32);
}
