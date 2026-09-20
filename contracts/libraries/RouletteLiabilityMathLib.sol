// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";
import { RouletteLib } from "../RouletteLib.sol";

/// @dev Linked library: worst-case liability aggregation + safety buffer (moves bytecode off `RouletteEngine`).
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
        if (paidSoFar + requested > fromRound($, roundId, marketId)) {
            revert PayoutExceedsMarketLiability();
        }
    }
    function fromRound(RouletteEngineStorageLib.Layout storage $, uint64 rid, uint32 mid)
        public
        view
        returns (uint256)
    {
        Inputs memory liab;
        liab.maxStraightBet = $.roundMaxStraightBet[rid][mid];
        liab.maxStreetBet = $.roundMaxStreetBet[rid][mid];
        liab.redSum = $.roundRedBetsSum[rid][mid];
        liab.blackSum = $.roundBlackBetsSum[rid][mid];
        liab.oddSum = $.roundOddBetsSum[rid][mid];
        liab.evenSum = $.roundEvenBetsSum[rid][mid];
        liab.lowSum = $.roundLowBetsSum[rid][mid];
        liab.highSum = $.roundHighBetsSum[rid][mid];
        liab.dozen1 = $.roundDozenBetsSum[rid][mid][1];
        liab.dozen2 = $.roundDozenBetsSum[rid][mid][2];
        liab.dozen3 = $.roundDozenBetsSum[rid][mid][3];
        liab.col1 = $.roundColumnBetsSum[rid][mid][1];
        liab.col2 = $.roundColumnBetsSum[rid][mid][2];
        liab.col3 = $.roundColumnBetsSum[rid][mid][3];
        liab.otherBetsWeightedPayout = $.roundOtherBetsWeightedPayout[rid][mid];
        return bufferedMarketMaxLiability(liab);
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

    function bufferedMarketMaxLiability(Inputs memory i) public pure returns (uint256) {
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
