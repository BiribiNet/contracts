// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ISideBet } from "../interfaces/ISideBet.sol";

/// @title SideBetOutcomeLib — pure outcome evaluation for side bets.
/// @notice Evaluates a bet against the spins observed so far. Returns whether the bet can be
///         settled now (`decided`) and, if so, whether the player won. Win conditions resolve
///         early as soon as they are met; losses are only final once the full window is observed
///         (or once a win is provably impossible for RED_RATIO).
library SideBetOutcomeLib {
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev European single-zero wheel red pockets. Matches `RouletteBetLib._isRedNumber`.
    function isRed(uint8 num) internal pure returns (bool) {
        return (num == 1 ||
            num == 3 ||
            num == 5 ||
            num == 7 ||
            num == 9 ||
            num == 12 ||
            num == 14 ||
            num == 16 ||
            num == 18 ||
            num == 19 ||
            num == 21 ||
            num == 23 ||
            num == 25 ||
            num == 27 ||
            num == 30 ||
            num == 32 ||
            num == 34 ||
            num == 36);
    }

    function _matchesColor(uint8 num, ISideBet.SideBetColor color) private pure returns (bool) {
        if (color == ISideBet.SideBetColor.RED) return isRed(num);
        // BLACK: any non-zero pocket that is not red (0 is green and matches neither colour).
        return num != 0 && !isRed(num);
    }

    /// @param observed Spins seen so far within the window (length <= windowSpins).
    /// @param windowComplete True once `observed.length == windowSpins`.
    /// @param bet Snapshotted bet parameters (betType, color, targets, window).
    /// @return decided Whether the bet can be settled now.
    /// @return won Whether the player won (only meaningful when `decided`).
    function evaluate(
        uint8[] memory observed,
        bool windowComplete,
        ISideBet.Bet memory bet
    ) internal pure returns (bool decided, bool won) {
        if (bet.betType == ISideBet.SideBetType.NUMBER_HIT) {
            uint256 hits;
            for (uint256 i; i < observed.length; ++i) {
                if (observed[i] == bet.targetNumber) ++hits;
            }
            if (hits >= bet.targetCount) return (true, true);
            return (windowComplete, false);
        }

        if (bet.betType == ISideBet.SideBetType.COLOR_COUNT) {
            uint256 count;
            for (uint256 i; i < observed.length; ++i) {
                if (_matchesColor(observed[i], bet.color)) ++count;
            }
            if (count >= bet.targetCount) return (true, true);
            return (windowComplete, false);
        }

        if (bet.betType == ISideBet.SideBetType.CONSECUTIVE_STREAK) {
            uint256 run;
            for (uint256 i; i < observed.length; ++i) {
                if (_matchesColor(observed[i], bet.color)) {
                    unchecked {
                        ++run;
                    }
                    if (run >= bet.targetCount) return (true, true);
                } else {
                    run = 0;
                }
            }
            return (windowComplete, false);
        }

        // RED_RATIO: win if reds make up at least `redRatioBps` of the full window.
        uint256 requiredReds = (uint256(bet.redRatioBps) * bet.windowSpins + (BPS_DENOMINATOR - 1)) / BPS_DENOMINATOR;
        uint256 reds;
        for (uint256 i; i < observed.length; ++i) {
            if (isRed(observed[i])) ++reds;
        }
        if (reds >= requiredReds) return (true, true);
        uint256 remaining = uint256(bet.windowSpins) - observed.length;
        if (reds + remaining < requiredReds) return (true, false);
        return (windowComplete, false);
    }
}
