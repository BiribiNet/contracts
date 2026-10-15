// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteLib } from "../RouletteLib.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";

/// @dev Linked library: worst-case liability aggregation + safety buffer (moves bytecode off `RouletteEngine`).
import { IBankVault } from "../interfaces/IBankVault.sol";
library RouletteLiabilityMathLib {
    error PayoutExceedsMarketLiability();
    function assertPayoutWithinLiability(
        uint64 roundId,
        uint32 marketId,
        IBankVault.Payout[] memory rows
    ) external view {
        RouletteEngineStorageLib.Layout storage $ = RouletteEngineStorageLib.layout();
        uint256 requested;
        for (uint256 i; i < rows.length; ) {
            requested += rows[i].amount;
            unchecked {
                ++i;
            }
        }
        uint256 paidSoFar = $.marketRoundStateByRound[roundId][marketId].bankPaidRunning;
        if (paidSoFar + requested > bufferedMarketMaxLiabilityFromRound($, roundId, marketId)) {
            revert PayoutExceedsMarketLiability();
        }
    }

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

    function bufferedMarketMaxLiability(Inputs memory i) internal pure returns (uint256) {
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

    function bufferedMarketMaxLiabilityFromRound(
        RouletteEngineStorageLib.Layout storage $,
        uint64 rid,
        uint32 mid
    ) public view returns (uint256) {
        Inputs memory i;
        i.maxStraightBet = $.roundMaxStraightBet[rid][mid];
        i.maxStreetBet = $.roundMaxStreetBet[rid][mid];
        i.redSum = $.roundRedBetsSum[rid][mid];
        i.blackSum = $.roundBlackBetsSum[rid][mid];
        i.oddSum = $.roundOddBetsSum[rid][mid];
        i.evenSum = $.roundEvenBetsSum[rid][mid];
        i.lowSum = $.roundLowBetsSum[rid][mid];
        i.highSum = $.roundHighBetsSum[rid][mid];
        i.dozen1 = $.roundDozenBetsSum[rid][mid][1];
        i.dozen2 = $.roundDozenBetsSum[rid][mid][2];
        i.dozen3 = $.roundDozenBetsSum[rid][mid][3];
        i.col1 = $.roundColumnBetsSum[rid][mid][1];
        i.col2 = $.roundColumnBetsSum[rid][mid][2];
        i.col3 = $.roundColumnBetsSum[rid][mid][3];
        i.otherBetsWeightedPayout = $.roundOtherBetsWeightedPayout[rid][mid];
        return bufferedMarketMaxLiability(i);
    }
}
