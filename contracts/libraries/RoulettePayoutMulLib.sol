// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Linked library: straight payout multipliers (must match `RouletteEngine` bet type ids).
library RoulettePayoutMulLib {
    uint8 private constant BET_STRAIGHT = 1;
    uint8 private constant BET_SPLIT = 2;
    uint8 private constant BET_STREET = 3;
    uint8 private constant BET_CORNER = 4;
    uint8 private constant BET_LINE = 5;
    uint8 private constant BET_COLUMN = 6;
    uint8 private constant BET_DOZEN = 7;
    uint8 private constant BET_RED = 8;
    uint8 private constant BET_BLACK = 9;
    uint8 private constant BET_ODD = 10;
    uint8 private constant BET_EVEN = 11;
    uint8 private constant BET_LOW = 12;
    uint8 private constant BET_HIGH = 13;
    uint8 private constant BET_TRIO_012 = 14;
    uint8 private constant BET_TRIO_023 = 15;

    function payoutForAmount(uint8 betType, uint256 amount) external pure returns (uint256) {
        if (betType == BET_STRAIGHT) return amount * 36;
        if (betType == BET_SPLIT) return amount * 18;
        if (betType == BET_STREET) return amount * 12;
        if (betType == BET_CORNER) return amount * 9;
        if (betType == BET_LINE) return amount * 6;
        if (betType == BET_COLUMN || betType == BET_DOZEN) return amount * 3;
        if (betType >= BET_RED && betType <= BET_HIGH) return amount * 2;
        if (betType == BET_TRIO_012 || betType == BET_TRIO_023) return amount * 12;
        return 0;
    }
}
