// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { IMarketRegistry } from "../interfaces/IMarketRegistry.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";

/// @dev Linked library: cross-market jackpot-eligible straight stake collection (offloads `RouletteEngine`).
library RouletteJackpotCollectLib {
    struct CollectState {
        address[] winners;
        uint256[] stakes;
        uint256 out;
        uint256 totalStake;
    }

    function normalizeStakeWeight(uint256 amount, uint8 assetDecimals) public pure returns (uint256) {
        if (assetDecimals == 18) return amount;
        if (assetDecimals < 18) return amount * (10 ** uint256(18 - assetDecimals));
        return amount / (10 ** uint256(assetDecimals - 18));
    }

    function collectJackpotEligibleStraightStakes(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber
    ) external view returns (address[] memory winners, uint256[] memory stakes, uint256 totalStake) {
        uint256 maxEntries = _countEligible($, roundId, winningNumber);
        CollectState memory st;
        st.winners = new address[](maxEntries);
        st.stakes = new uint256[](maxEntries);

        uint32 totalMarkets = $.REGISTRY.marketCount();
        for (uint32 mid = 1; mid <= totalMarkets; ) {
            if ($._roundHasMarket[roundId][mid]) {
                st = _appendMarket($, roundId, mid, winningNumber, st);
            }
            unchecked {
                ++mid;
            }
        }

        uint256 filled = st.out;
        winners = st.winners;
        stakes = st.stakes;
        totalStake = st.totalStake;
        assembly ("memory-safe") {
            mstore(winners, filled)
            mstore(stakes, filled)
        }
    }

    function _countEligible(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber
    ) private view returns (uint256 maxEntries) {
        uint32 totalMarkets = $.REGISTRY.marketCount();
        for (uint32 mid = 1; mid <= totalMarkets; ) {
            if ($._roundHasMarket[roundId][mid]) {
                RouletteEngineStorageLib.BetEntry[] storage bucket = $.roundNumberedBets[roundId][mid][uint8(
                    RouletteEngineStorageLib.NumberedBetBucket.Straight
                )][winningNumber];
                maxEntries += bucket.length;
            }
            unchecked {
                ++mid;
            }
        }
    }

    function _appendMarket(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        CollectState memory st
    ) private view returns (CollectState memory) {
        IMarketRegistry.MarketConfig memory mc = $.REGISTRY.getMarket(marketId);
        uint8 dec = IERC20Metadata(mc.asset).decimals();
        // Jackpot eligibility requires the straight stake to meet the market minimum; this excludes
        // dust legs (e.g. 1 wei on every number) that would otherwise buy a free jackpot ticket.
        uint256 minBet = IBankVault(mc.bank).minBet();
        RouletteEngineStorageLib.BetEntry[] storage bucket = $.roundNumberedBets[roundId][marketId][uint8(
            RouletteEngineStorageLib.NumberedBetBucket.Straight
        )][winningNumber];
        uint256 len = bucket.length;
        uint256 a;
        uint256 stake;
        for (uint256 j; j < len; ) {
            a = uint256(bucket[j].amount);
            if (a >= minBet) {
                st.winners[st.out] = bucket[j].player;
                stake = normalizeStakeWeight(a, dec);
                st.stakes[st.out] = stake;
                st.totalStake += stake;
                unchecked {
                    ++st.out;
                }
            }
            unchecked {
                ++j;
            }
        }
        return st;
    }
}
