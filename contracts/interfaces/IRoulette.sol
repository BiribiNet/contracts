// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRoulette {
    struct PayoutInfo {
        address player;
        uint256 betAmount;
        uint256 payout;
    }
}