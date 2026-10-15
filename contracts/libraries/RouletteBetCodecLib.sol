// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteBetErrors } from "../interfaces/IRouletteBetErrors.sol";
import { RouletteBetLib } from "./RouletteBetLib.sol";

/// @dev Linked library: typed bet decoding / routing / number validation (must match `RouletteEngine` bet type ids).
library RouletteBetCodecLib {
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

    function validateBetNumber(uint256 betType, uint256 number) external pure {
        if (betType == BET_STRAIGHT) {
            if (number > 36) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (betType == BET_SPLIT) {
            if (!RouletteBetLib.isValidSplit(number)) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (betType == BET_STREET) {
            if (number == 0 || number > 34 || (number - 1) % 3 != 0) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (betType == BET_CORNER) {
            if (!RouletteBetLib.isValidCorner(number)) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (betType == BET_LINE) {
            if (number == 0 || number > 31 || (number - 1) % 3 != 0) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (betType == BET_COLUMN || betType == BET_DOZEN) {
            if (number == 0 || number > 3) revert IRouletteBetErrors.InvalidBetNumber();
            return;
        }
        if (number != 0) revert IRouletteBetErrors.InvalidBetNumber();
    }

    function routeBet(uint8 betType) external pure returns (bool isNumbered, uint8 bucket) {
        if (betType <= BET_DOZEN) return (true, betType - BET_STRAIGHT);
        if (betType >= BET_RED && betType <= BET_TRIO_023) return (false, betType - BET_RED);
        revert IRouletteBetErrors.InvalidBetType();
    }
}
