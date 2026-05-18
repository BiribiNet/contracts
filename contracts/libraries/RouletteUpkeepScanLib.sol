// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";

/// @dev Linked library: payout-finder scan helpers for `findNextJob` (offloads `RouletteEngine`).
library RouletteUpkeepScanLib {
    function payoutFinderScanStarts(RouletteEngineStorageLib.Layout storage $, uint32 totalMarkets)
        private
        view
        returns (uint64 rStart, uint32 mStart)
    {
        uint64 gr = $._globalRound;
        rStart = $._payoutFinderRound;
        mStart = $._payoutFinderMarket;
        if (totalMarkets == 0) {
            return (1, 1);
        }
        if (rStart == 0 || rStart > gr) {
            rStart = 1;
            mStart = 1;
        }
        if (mStart == 0 || mStart > totalMarkets) {
            mStart = 1;
        }
    }

    function advancePayoutFinderHintAfterSettlement(
        RouletteEngineStorageLib.Layout storage $,
        uint64 settledRound,
        uint32 settledMarket,
        uint32 totalMarkets
    ) external {
        if ($._payoutFinderRound != settledRound || $._payoutFinderMarket != settledMarket) {
            return;
        }
        if (totalMarkets == 0) return;

        unchecked {
            uint64 nextR = settledRound;
            uint32 nextM = settledMarket + 1;
            if (nextM > totalMarkets) {
                nextM = 1;
                nextR = settledRound + 1;
            }
            uint64 gr = $._globalRound;
            if (nextR > gr) {
                $._payoutFinderRound = 1;
                $._payoutFinderMarket = 1;
            } else {
                $._payoutFinderRound = nextR;
                $._payoutFinderMarket = nextM;
            }
        }
    }

    /// @dev First unsettled market with bets; every automation lane may service it (winner sharding is per-lane).
    function findFirstPayout(RouletteEngineStorageLib.Layout storage $, uint32 totalMarkets)
        external
        view
        returns (uint64 roundId, uint32 marketId)
    {
        uint64 gr = $._globalRound;
        if (totalMarkets == 0) {
            return (0, 0);
        }
        (uint64 roundStart, uint32 marketScanStart) = payoutFinderScanStarts($, totalMarkets);
        for (uint64 r = roundStart; r <= gr; ) {
            if ($.globalRoundState[r].vrfFulfilled) {
                uint32 m0 = (r == roundStart) ? marketScanStart : uint32(1);
                for (uint32 m = m0; m <= totalMarkets; ) {
                    RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[r][m];
                    if (!mr.settled && mr.totals.betCount > 0) {
                        return (r, m);
                    }
                    unchecked {
                        ++m;
                    }
                }
            }
            unchecked {
                ++r;
            }
        }
        return (0, 0);
    }
}
