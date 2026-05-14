// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteLib } from "../RouletteLib.sol";

/// @dev Linked library: worst-case liability aggregation + safety buffer (moves bytecode off `RouletteEngine`).
library RouletteLiabilityMathLib {
    struct Inputs {
        uint256 maxStraightBet;
        uint256 maxStreetBet;
        uint256 redSum;
        uint256 blackSum;
        uint256 oddSum;
        uint256 evenSum;
        uint256 lowSum;
        uint256 highSum;
        uint256 dozen1;
        uint256 dozen2;
        uint256 dozen3;
        uint256 col1;
        uint256 col2;
        uint256 col3;
        uint256 otherBetsWeightedPayout;
    }

    function bufferedMarketMaxLiability(Inputs memory i) external pure returns (uint256) {
        unchecked {
            uint256 ss = i.maxStraightBet * 36 + i.maxStreetBet * 12;
            uint256 rb = RouletteLib.max(i.redSum, i.blackSum) * 2;
            uint256 oe = RouletteLib.max(i.oddSum, i.evenSum) * 2;
            uint256 lh = RouletteLib.max(i.lowSum, i.highSum) * 2;
            uint256 dc = RouletteLib.max3(i.dozen1, i.dozen2, i.dozen3) * 3
                + RouletteLib.max3(i.col1, i.col2, i.col3) * 3;
            uint256 raw = ss + rb + oe + lh + dc + i.otherBetsWeightedPayout;
            return RouletteLib.applySafetyBuffer(raw);
        }
    }
}
