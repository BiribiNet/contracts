// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

library BetStorageLib {
    struct RoundTotals {
        uint256 totalAmount;
        uint256 betCount;
    }

    function addBet(RoundTotals storage totals, uint256 amount) internal {
        totals.totalAmount += amount;
        totals.betCount += 1;
    }
}
