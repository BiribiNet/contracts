// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";

/// @dev Linked library: payout-finder for `findNextJob` (offloads `RouletteEngine`).
/// @notice At most one global round owes payout work: `_globalRound` only increments in
///         `_openNextRound` after `_isRoundDone`, so older round ids are always fully settled.
library RouletteUpkeepScanLib {
    /// @dev First unsettled market with bets on the active settling round.
    ///      Every payout lane services the same `(roundId, marketId)`; winner sharding is per-lane.
    function findFirstPayout(RouletteEngineStorageLib.Layout storage $, uint32 totalMarkets)
        external
        view
        returns (uint64 roundId, uint32 marketId)
    {
        if (totalMarkets == 0) {
            return (0, 0);
        }
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Settling) {
            return (0, 0);
        }

        uint64 r = $._globalRound;
        if (!$.globalRoundState[r].vrfFulfilled) {
            return (0, 0);
        }

        for (uint32 m = 1; m <= totalMarkets; ) {
            RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[r][m];
            if (!mr.settled && mr.totals.betCount > 0) {
                return (r, m);
            }
            unchecked {
                ++m;
            }
        }
        return (0, 0);
    }
}
