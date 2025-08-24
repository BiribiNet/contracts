// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRoulette {
    struct PayoutInfo {
        address player;
        uint256 betAmount;
        uint256 payout;
    }
    
    /**
     * @dev Process roulette results - called by Roulette contract (BATCH PROCESSING)
     * @param payouts Array of payout info for multiple winners/losers
     * @param isLastBatch Whether this is the final batch for the current round
     */
    function processRouletteResult(PayoutInfo[] memory payouts, bool isLastBatch) external;
}