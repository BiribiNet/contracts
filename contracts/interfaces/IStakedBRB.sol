// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IStakedBRB {
    function processRouletteResult(uint256 roundId, IRoulette.PayoutInfo[] memory payouts, uint256 totalPayouts, bool isLastBatch) external;
    function onRoundTransition() external;

    /// @notice Seconds per betting round. {IRoulette.gamePeriod} on the roulette contract returns this value.
    function gamePeriod() external view returns (uint256);

    function lastRoundBoundaryTimestamp() external view returns (uint256);
    function roundTransitionInProgress() external view returns (bool);
    function roundResolutionLocked() external view returns (bool);

    /// @notice True when the betting window is open (same rules as {IRoulette.isBettingOpen} on the roulette contract).
    function isBettingOpen() external view returns (bool);

    /// @dev Seconds until pre-VRF / VRF window (same timing as former {RouletteClean.getSecondsFromNextUpkeepWindow}).
    function getSecondsFromNextUpkeepWindow() external view returns (uint256);

    /// @notice True when the VRF upkeep should run (after game period + no-bet lock, resolution locked, not in transition).
    function isVrfUpkeepNeeded() external view returns (bool);
}