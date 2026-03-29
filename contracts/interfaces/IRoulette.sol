// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRoulette {
    struct PayoutInfo {
        address player;
        uint256 payout;
    }

    function bet(address player, uint256 amount, bytes calldata data) external returns (uint256);

    /// @notice Called by StakedBRB after cleaning upkeep advances the betting round; syncs roulette `currentRound`.
    function onRoundBoundary() external;

    /// @notice Betting window length in seconds; {RouletteClean} returns {IStakedBRB.gamePeriod}.
    function gamePeriod() external view returns (uint256);

    /// @notice True when betting is allowed; implemented on {IStakedBRB} and this contract delegates to it.
    function isBettingOpen() external view returns (bool);

    /// @dev VRF / compute / payout checks. Pre-VRF lock is implemented only on {StakedBRB.checkUpkeep} (empty checkData).
    function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData);

    function performUpkeep(bytes calldata performData) external;
}