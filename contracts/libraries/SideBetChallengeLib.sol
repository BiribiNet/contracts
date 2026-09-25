// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {ISideBet} from "../interfaces/ISideBet.sol";
import {SideBetOutcomeLib} from "./SideBetOutcomeLib.sol";
library SideBetChallengeLib {
    function _dozenOf(uint8 n) private pure returns (uint8) {
        return n == 0 ? 0 : (n - 1) / 12 + 1;
    }
    function _matchesColor(uint8 n, ISideBet.SideBetColor c) private pure returns (bool) {
        return c == ISideBet.SideBetColor.RED ? SideBetOutcomeLib.isRed(n) : (n != 0 && !SideBetOutcomeLib.isRed(n));
    }
    /// @dev Append-only enum extension: existing nine families and storage layout are unchanged.
    function evaluateChallenge(
        uint8[] memory observed,
        bool complete,
        ISideBet.Bet memory bet
    ) internal pure returns (bool decided, bool won) {
        uint256 mask;
        uint256 collected;
        uint256 own;
        uint256 other;
        for (uint256 i; i < observed.length; ++i) {
            uint8 n = observed[i];
            if (
                bet.betType == ISideBet.SideBetType.DOZEN_PASSPORT ||
                bet.betType == ISideBet.SideBetType.DISTINCT_COLLECTION
            ) {
                if (bet.betType == ISideBet.SideBetType.DOZEN_PASSPORT && n == 0) continue;
                uint256 bit = uint256(1) << (bet.betType == ISideBet.SideBetType.DOZEN_PASSPORT ? _dozenOf(n) : n);
                if (mask & bit == 0) {
                    mask |= bit;
                    ++collected;
                }
                if (collected >= bet.targetCount) return (true, true);
            } else if (bet.betType == ISideBet.SideBetType.COLOR_DUEL) {
                if (n == 0) continue;
                if (_matchesColor(n, bet.color)) {
                    if (++own >= bet.targetCount) return (true, true);
                } else {
                    if (++other >= bet.targetCount) return (true, false);
                }
            } else if (bet.betType == ISideBet.SideBetType.BOOMERANG) {
                if (i >= 2 && n == observed[i - 2] && n != observed[i - 1]) return (true, true);
            } else if (i > 0) {
                if (bet.betType == ISideBet.SideBetType.MIRROR_PAIR && uint256(n) + observed[i - 1] == 36)
                    return (true, true);
                if (bet.betType == ISideBet.SideBetType.WHEEL_NEIGHBORS && adjacent(n, observed[i - 1]))
                    return (true, true);
            }
        }
        return (complete, false);
    }

    function adjacent(uint8 a, uint8 b) private pure returns (bool) {
        // European wheel, clockwise from zero. Includes wraparound 26 <-> 0.
        bytes memory wheel = hex"00200f13041502191122061b0d240b1e08170a0518102101140e1f0916121d071c0c23031a";
        for (uint256 i; i < 37; ++i)
            if (uint8(wheel[i]) == a) return uint8(wheel[(i + 1) % 37]) == b || uint8(wheel[(i + 36) % 37]) == b;
        return false;
    }
}
