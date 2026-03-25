// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IStakedBRB {
    function processRouletteResult(uint256 roundId, IRoulette.PayoutInfo[] memory payouts, uint256 totalPayouts, bool isLastBatch) external;
    function onBettingWindowClosed() external;
    function onRoundTransition(uint256 newRoundId) external;

    function lastRoundBoundaryTimestamp() external view returns (uint256);
    function roundTransitionInProgress() external view returns (bool);
    function roundResolutionLocked() external view returns (bool);
}