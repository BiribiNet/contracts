// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IJackpotContract {
    function jackpotWin(IRoulette.PayoutInfo[] calldata payouts) external;
}