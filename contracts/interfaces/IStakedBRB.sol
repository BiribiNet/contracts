// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IStakedBRB {
    function processRouletteResult(uint256 roundId, IRoulette.PayoutInfo[] memory payouts, bool isLastBatch, uint256 totalPayouts) external;
    function onRoundTransition(uint256 newRoundId, uint256 previousRoundId) external;
}