// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {ISideBet} from "./interfaces/ISideBet.sol";
import {SideBetChallengeLib} from "./libraries/SideBetChallengeLib.sol";
import {SideBetOutcomeLib} from "./libraries/SideBetOutcomeLib.sol";
/// @notice Stateless evaluator created with each SideBet implementation; no admin or mutable rules.
contract SideBetChallengeEvaluator {
    /// @notice Immutable stateless validation keeps the upgrade implementation below EIP-170.
    function validConfig(ISideBet.SideBetConfig calldata cfg) external pure returns (bool) {
        if (uint8(cfg.betType) >= uint8(ISideBet.SideBetType.FIRST_RETURN)) {
            if (cfg.windowSpins < 2 || cfg.windowSpins > 64) return false;
            if (cfg.betType == ISideBet.SideBetType.SUM_RANGE) {
                // Inclusive bounds: targetNumber = lower, redRatioBps = upper (not a ratio).
                if (cfg.windowSpins != 3 || cfg.targetCount != 0 || cfg.targetNumber > cfg.redRatioBps || cfg.redRatioBps > 108 || (cfg.targetNumber == 0 && cfg.redRatioBps == 108)) return false;
            } else if (cfg.betType == ISideBet.SideBetType.EXACT_DOZEN) {
                if (cfg.targetNumber < 1 || cfg.targetNumber > 3 || cfg.targetCount > cfg.windowSpins || cfg.redRatioBps != 0) return false;
            } else {
                if (cfg.targetNumber != 0 || cfg.targetCount != 0 || cfg.redRatioBps != 0) return false;
                if (cfg.betType == ISideBet.SideBetType.COLOR_MIRROR && cfg.windowSpins != 4) return false;
                if (cfg.betType == ISideBet.SideBetType.STRICT_ASCENT && cfg.windowSpins != 3) return false;
            }
        } else if (uint8(cfg.betType) >= uint8(ISideBet.SideBetType.DOZEN_PASSPORT)) {
            // Bound per-ticket evaluation cost for the new challenge families.
            if (cfg.windowSpins > 64 || cfg.targetNumber != 0 || cfg.redRatioBps != 0) return false;
            if (cfg.betType == ISideBet.SideBetType.DOZEN_PASSPORT) {
                if (cfg.windowSpins < 3 || cfg.targetCount != 3) return false;
            } else if (cfg.betType == ISideBet.SideBetType.DISTINCT_COLLECTION) {
                if (cfg.targetCount < 2 || cfg.targetCount > 37 || cfg.targetCount > cfg.windowSpins) return false;
            } else if (cfg.betType == ISideBet.SideBetType.COLOR_DUEL) {
                if (cfg.targetCount < 1 || cfg.targetCount > cfg.windowSpins) return false;
            } else {
                if (cfg.targetCount != 0 || cfg.windowSpins < (cfg.betType == ISideBet.SideBetType.BOOMERANG ? 3 : 2)) return false;
            }

        }
        return true;
    }
    function evaluate(uint8[] memory nums, bool complete, ISideBet.Bet memory bet) external pure returns (bool, bool) {
        if (uint8(bet.betType) >= uint8(ISideBet.SideBetType.DOZEN_PASSPORT)) {
            return SideBetChallengeLib.evaluateChallenge(nums, complete, bet);
        }
        return SideBetOutcomeLib.evaluate(nums, complete, bet);
    }
}
