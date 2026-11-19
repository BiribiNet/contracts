// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteDualBetRules as Rules } from "../libraries/RouletteDualBetRules.sol";

contract DualBetRulesHarness {
    function tally(uint256 raw) external pure returns (uint256 wins, uint256 refunds, uint256, uint256) {
        Rules.Selection memory selection = Rules.decode(raw);
        for (uint8 r; r < 37; ++r) {
            for (uint8 j; j < 37; ++j) {
                uint8 outcome = Rules.outcome(selection.variant, selection.rouletteMask, selection.jackpotMask, r, j);
                if (outcome == 2) ++wins;
                if (outcome == 1) ++refunds;
            }
        }
        (uint256 rateWins, uint256 rateRefunds) = Rules.odds(selection);
        return (wins, refunds, rateWins, rateRefunds);
    }
}
