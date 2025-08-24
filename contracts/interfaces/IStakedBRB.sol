// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IStakedBRB {
    function processRouletteResult(IRoulette.PayoutInfo[] memory payouts, bool isLastBatch) external;
}