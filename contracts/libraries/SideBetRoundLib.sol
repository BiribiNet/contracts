// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";

/// @title SideBetRoundLib — load consecutive global-round outcomes for side-bet evaluation.
library SideBetRoundLib {
    /// @dev Returns observed spins for rounds `[startRound, startRound + count - 1]` and whether all are VRF-fulfilled.
    function loadWindow(
        IRouletteEngine engine,
        uint64 startRound,
        uint256 count
    ) internal view returns (uint8[] memory observed, bool allFulfilled) {
        if (count == 0) {
            return (new uint8[](0), true);
        }
        observed = new uint8[](count);
        allFulfilled = true;
        uint64 roundId = startRound;
        bool fulfilled;
        uint8 number;
        for (uint256 i; i < count; ) {
            (fulfilled, number) = engine.roundOutcome(roundId);
            if (!fulfilled) {
                allFulfilled = false;
                break;
            }
            observed[i] = number;
            unchecked {
                ++i;
                ++roundId;
            }
        }
    }

    /// @dev True when rounds `startRound .. startRound + windowSpins - 1` are all VRF-fulfilled.
    function windowFulfilled(IRouletteEngine engine, uint64 startRound, uint16 windowSpins) internal view returns (bool) {
        if (windowSpins == 0) return false;
        uint64 endRound = startRound + uint64(windowSpins) - 1;
        uint64 cur = engine.currentGlobalRound();
        if (endRound > cur) return false;
        bool fulfilled;
        if (endRound == cur) {
            (fulfilled, ) = engine.roundOutcome(cur);
            return fulfilled;
        }
        for (uint64 r = startRound; r <= endRound; ) {
            (fulfilled, ) = engine.roundOutcome(r);
            if (!fulfilled) return false;
            unchecked {
                ++r;
            }
        }
        return true;
    }

    /// @dev Win if any VRF-fulfilled round in `[startRound, startRound + windowSpins - 1]` had the jackpot drawn.
    function evaluateJackpotWindow(
        IRouletteEngine engine,
        uint64 startRound,
        uint16 windowSpins
    ) internal view returns (bool decided, bool won) {
        if (windowSpins == 0) return (false, false);

        uint64 endRound = startRound + uint64(windowSpins) - 1;
        uint64 cur = engine.currentGlobalRound();
        bool fulfilled;
        bool jackpot;
        for (uint64 r = startRound; r <= endRound; ) {
            if (r > cur) return (false, false);
            (fulfilled, jackpot) = engine.roundJackpotTriggered(r);
            if (!fulfilled) return (false, false);
            if (jackpot) return (true, true);
            unchecked {
                ++r;
            }
        }
        return (true, false);
    }
}
