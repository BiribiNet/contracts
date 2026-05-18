// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";

/// @dev Linked library: per-bet worst-case exposure accumulators (offloads `recordBet` bytecode).
library RouletteExposureLib {
    uint8 private constant BET_STRAIGHT = 1;
    uint8 private constant BET_STREET = 3;
    uint8 private constant BET_SPLIT = 2;
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

    function accumulate(
        RouletteEngineStorageLib.Layout storage $,
        uint64 rid,
        uint32 mid,
        uint8 betType,
        uint16 number,
        uint128 amt128
    ) external {
        uint256 amount = uint256(amt128);
        unchecked {
            if (betType == BET_STRAIGHT) {
                uint256 row = $.roundStraightBetsSum[rid][mid][number];
                if (row > $.roundMaxStraightBet[rid][mid]) {
                    $.roundMaxStraightBet[rid][mid] = row;
                }
                return;
            }
            if (betType == BET_STREET) {
                uint256 t = $.roundStreetBetsTotal[rid][mid][number] + amount;
                $.roundStreetBetsTotal[rid][mid][number] = t;
                if (t > $.roundMaxStreetBet[rid][mid]) {
                    $.roundMaxStreetBet[rid][mid] = t;
                }
                return;
            }
            if (betType == BET_SPLIT) {
                $.roundOtherBetsWeightedPayout[rid][mid] += amount * 18;
                return;
            }
            if (betType == BET_CORNER) {
                $.roundOtherBetsWeightedPayout[rid][mid] += amount * 9;
                return;
            }
            if (betType == BET_LINE) {
                $.roundOtherBetsWeightedPayout[rid][mid] += amount * 6;
                return;
            }
            if (betType == BET_COLUMN) {
                $.roundColumnBetsSum[rid][mid][number] += amount;
                return;
            }
            if (betType == BET_DOZEN) {
                $.roundDozenBetsSum[rid][mid][number] += amount;
                return;
            }
            if (betType == BET_RED) {
                $.roundRedBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_BLACK) {
                $.roundBlackBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_ODD) {
                $.roundOddBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_EVEN) {
                $.roundEvenBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_LOW) {
                $.roundLowBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_HIGH) {
                $.roundHighBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_TRIO_012 || betType == BET_TRIO_023) {
                $.roundOtherBetsWeightedPayout[rid][mid] += amount * 12;
            }
        }
    }
}
