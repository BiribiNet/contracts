// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {ISideBet} from "./interfaces/ISideBet.sol";
import {SideBetChallengeLib} from "./libraries/SideBetChallengeLib.sol";
import {SideBetOutcomeLib} from "./libraries/SideBetOutcomeLib.sol";
/// @notice Stateless evaluator created with each SideBet implementation; no admin or mutable rules.
contract SideBetChallengeEvaluator {
    function evaluate(uint8[] memory nums, bool complete, ISideBet.Bet memory bet) external pure returns (bool, bool) {
        if (uint8(bet.betType) >= uint8(ISideBet.SideBetType.DOZEN_PASSPORT)) {
            return SideBetChallengeLib.evaluateChallenge(nums, complete, bet);
        }
        return SideBetOutcomeLib.evaluate(nums, complete, bet);
    }
}
