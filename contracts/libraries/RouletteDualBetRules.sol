// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteBetErrors } from "../interfaces/IRouletteBetErrors.sol";

library RouletteDualBetRules {
    uint8 internal constant BET_DUAL = 17;
    uint8 internal constant DOUBLE_MASK = 4;
    uint8 internal constant REFUND_MASK = 5;
    uint8 internal constant EXACT_PAIR = 6;
    uint8 internal constant DOUBLE_ZERO = 7;
    uint256 internal constant POCKETS = 37;
    uint256 internal constant PAYOUT_BUDGET = 1332;
    uint256 private constant RED = 0x154aad52aa;
    // Six bits per pocket number, with the clockwise wheel position of zero at bit zero.
    uint256 private constant WHEEL_POSITIONS = 0xd88958168f7a02e41d445c1580dd2150993213926d07ca4c48c65c0;

    struct Selection {
        uint8 variant;
        uint40 rouletteMask;
        uint40 jackpotMask;
        uint8 rouletteSize;
        uint8 jackpotSize;
    }

    // Low 3 bits: variant. Then two 24-bit lists of four 6-bit fields each.
    // Each field holds pocket + 1, or zero for trailing padding.
    function decode(uint256 raw) internal pure returns (Selection memory selection) {
        selection.variant = uint8(raw & 7);
        if (raw >> 51 != 0) revert IRouletteBetErrors.InvalidBetNumber();
        if (selection.variant == DOUBLE_MASK || selection.variant == REFUND_MASK) {
            (selection.rouletteMask, selection.rouletteSize) = _decodePockets((raw >> 3) & 0xffffff);
            (selection.jackpotMask, selection.jackpotSize) = _decodePockets(raw >> 27);
        } else if (selection.variant == EXACT_PAIR) {
            if (raw >> 15 != 0) revert IRouletteBetErrors.InvalidBetNumber();
            (selection.rouletteMask, selection.rouletteSize) = _decodePockets(raw >> 3);
        } else if (raw >> 3 != 0) {
            revert IRouletteBetErrors.InvalidBetNumber();
        }
    }

    function _decodePockets(uint256 packed) private pure returns (uint40 mask, uint8 size) {
        uint256 previous;
        while (packed != 0) {
            uint256 field = packed & 63;
            if (field <= previous || field > POCKETS) revert IRouletteBetErrors.InvalidBetNumber();
            mask |= uint40(uint256(1) << (field - 1));
            previous = field;
            packed >>= 6;
            ++size;
        }
        if (size < 2) revert IRouletteBetErrors.InvalidBetNumber();
    }

    function odds(Selection memory selection) internal pure returns (uint256 wins, uint256 refunds) {
        uint8 variant = selection.variant;
        if (variant == 0) return (648, 0);
        if (variant == 1) return (96, 0);
        if (variant == 2) return (74, 0);
        if (variant == 3) return (36, 0);
        if (variant == EXACT_PAIR) return (2, 0);
        if (variant == DOUBLE_ZERO) return (1, 0);
        uint256 a = selection.rouletteSize;
        uint256 b = selection.jackpotSize;
        wins = a * b;
        if (variant == REFUND_MASK) refunds = (a + b) * POCKETS - 2 * wins;
    }

    function fixedWins(uint8 variant, uint8 roulette, uint8 jackpot) internal pure returns (bool) {
        if (variant == 0) {
            return roulette != 0 && jackpot != 0 && ((RED >> roulette) & 1) != ((RED >> jackpot) & 1);
        }
        if (variant == 1) return roulette != 0 && jackpot != 0 && roulette != jackpot && roulette % 10 == jackpot % 10;
        if (variant == 2) {
            uint8 a = uint8((WHEEL_POSITIONS >> (uint256(roulette) * 6)) & 63);
            uint8 b = uint8((WHEEL_POSITIONS >> (uint256(jackpot) * 6)) & 63);
            uint8 distance = a > b ? a - b : b - a;
            return distance == 1 || distance == 36;
        }
        if (variant == 3) return uint256(roulette) + jackpot == 37;
        return roulette == 0 && jackpot == 0;
    }

    function covers(uint40 mask, uint8 pocket) internal pure returns (bool) {
        return (mask >> pocket) & 1 == 1;
    }

    // 0 = lost, 1 = stake returned, 2 = won.
    function outcome(uint8 variant, uint40 rouletteMask, uint40 jackpotMask, uint8 roulette, uint8 jackpot)
        internal pure returns (uint8)
    {
        if (variant < DOUBLE_MASK || variant == DOUBLE_ZERO) return fixedWins(variant, roulette, jackpot) ? 2 : 0;
        bool hitRoulette = covers(rouletteMask, roulette);
        if (variant == EXACT_PAIR) return hitRoulette && roulette != jackpot && covers(rouletteMask, jackpot) ? 2 : 0;
        bool hitJackpot = covers(jackpotMask, jackpot);
        if (hitRoulette && hitJackpot) return 2;
        return variant == REFUND_MASK && hitRoulette != hitJackpot ? 1 : 0;
    }
}
