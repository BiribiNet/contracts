// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRoulette } from "./IRoulette.sol";

interface IBRB {
    function bet(address to, uint256 amount, bytes calldata data, address referral) external;
    function transferBatch(IRoulette.PayoutInfo[] calldata payouts) external;
    function burn(uint256 amount) external;
}
