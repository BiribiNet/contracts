// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRoulette {
    struct PayoutInfo {
        address player;
        uint256 payout;
    }

    function bet(address player, uint256 amount, bytes calldata data) external returns (uint256);
}