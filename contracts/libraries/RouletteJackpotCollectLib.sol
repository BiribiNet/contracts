// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { IMarketRegistry } from "../interfaces/IMarketRegistry.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";

/// @dev Linked library: cross-market jackpot-eligible straight stake collection (offloads `RouletteEngine`).
interface IJackpotTokenView { function brb() external view returns (address); }
library RouletteJackpotCollectLib {
    error StaleJackpotChunk();
    uint256 private constant PREPARATION_STEPS = 32;
    event JackpotPreparationProgress(uint64 indexed roundId, uint32 marketId, uint256 betCursor, bool ready);

    /// @dev Bound all state-changing collection work, including skipped dust and
    /// empty markets. Lane zero keeps reporting work until this snapshot is ready.
    function prepareJackpotSnapshot(RouletteEngineStorageLib.Layout storage $, uint64 roundId, uint8 number)
        external returns (bool)
    {
        RouletteEngineStorageLib.JackpotPreparation storage prep = $.jackpotPreparation[roundId];
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        if (prep.ready || gr.jackpotPoolSnapshot != 0 || gr.jackpotDistributed) return true;
        uint32 totalMarkets = $.REGISTRY.marketCount();
        uint32 mid = prep.marketId == 0 ? 1 : prep.marketId;
        uint256 cursor = prep.betCursor;
        for (uint256 steps; steps < PREPARATION_STEPS && mid <= totalMarkets; ++steps) {
            if (!$._roundHasMarket[roundId][mid]) { ++mid; cursor = 0; continue; }
            RouletteEngineStorageLib.BetEntry[] storage bucket = $.roundNumberedBets[roundId][mid][0][number];
            if (cursor >= bucket.length) { ++mid; cursor = 0; continue; }
            IMarketRegistry.MarketConfig memory mc = $.REGISTRY.getMarket(mid);
            RouletteEngineStorageLib.BetEntry storage entry = bucket[cursor++];
            if (entry.amount >= IBankVault(mc.bank).minBet()) {
                uint256 stake = normalizeStakeWeight(entry.amount, IERC20Metadata(mc.asset).decimals());
                prep.entries.push(RouletteEngineStorageLib.JackpotEligibleEntry(entry.player, stake));
                gr.jackpotTotalStake += stake;
                ++gr.jackpotWinnerCount;
            }
        }
        prep.marketId = mid;
        prep.betCursor = cursor;
        if (mid > totalMarkets) {
            prep.ready = true;
            gr.jackpotPoolSnapshot = $.JACKPOT_TREASURY.jackpotPool();
            if (gr.jackpotTotalStake == 0) gr.jackpotDistributed = true;
        }
        emit JackpotPreparationProgress(roundId, mid, cursor, prep.ready);
        return prep.ready;
    }

    function previewPreparedJackpot(RouletteEngineStorageLib.Layout storage $, uint64 roundId, uint32 maxRows)
        external view returns (address[] memory winners, uint256[] memory amounts)
    {
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        RouletteEngineStorageLib.JackpotPreparation storage prep = $.jackpotPreparation[roundId];
        uint256 start = gr.jackpotCursor;
        uint256 n = prep.entries.length;
        if (!prep.ready || gr.jackpotDistributed || start >= n || gr.jackpotTotalStake == 0) return (winners, amounts);
        uint256 count = n - start;
        if (count > maxRows) count = maxRows;
        if (count > PREPARATION_STEPS) count = PREPARATION_STEPS;
        winners = new address[](count);
        amounts = new uint256[](count);
        uint256 paid;
        for (uint256 i; i < count; ++i) {
            RouletteEngineStorageLib.JackpotEligibleEntry storage entry = prep.entries[start + i];
            winners[i] = entry.player;
            uint256 amount = start + i + 1 == n ? gr.jackpotPoolSnapshot - gr.jackpotPaid - paid
                : gr.jackpotPoolSnapshot * entry.stake / gr.jackpotTotalStake;
            amounts[i] = amount;
            paid += amount;
        }
    }

    function smallJackpot(RouletteEngineStorageLib.Layout storage $, uint64 roundId, uint8 number) external view returns (bool) {
        return _countEligible($, roundId, number) < PREPARATION_STEPS;
    }
    event JackpotPayment(uint64 indexed roundId, address indexed recipient, address indexed token, uint256 amount);
    function applyJackpotChunk(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        RouletteEngineStorageLib.GlobalRoundState storage gr,
        address[] memory winners,
        uint256[] memory amounts
    ) external {
        // The preview gates the jackpot on both of these; the apply path gated on neither, so a
        // payload carrying jackpot rows reached the treasury on rounds where no jackpot ever fired.
        if (!gr.jackpotTriggered) revert StaleJackpotChunk();
        if (marketId != $._roundTriggerMarket[roundId]) revert StaleJackpotChunk();
        if (gr.jackpotDistributed) revert StaleJackpotChunk();
        if (!$.jackpotPreparation[roundId].ready && gr.jackpotPoolSnapshot == 0) {
            (address[] memory allWinners,, uint256 totalStake) =
                collectJackpotEligibleStraightStakes($, roundId, winningNumber);
            gr.jackpotPoolSnapshot = $.JACKPOT_TREASURY.jackpotPool();
            gr.jackpotTotalStake = totalStake;
            gr.jackpotWinnerCount = uint32(allWinners.length);
        }
        // A raced duplicate of an already-applied chunk would overrun the winner count.
        if (uint256(gr.jackpotCursor) + winners.length > gr.jackpotWinnerCount) revert StaleJackpotChunk();

        // The winner count bounds how many rows may be paid, but not how much: bound the chunk by
        // what is left of this round's snapshotted pool so a single row cannot drain the treasury.
        uint256 requested;
        for (uint256 i; i < amounts.length; ) {
            requested += amounts[i];
            unchecked {
                ++i;
            }
        }
        uint256 remainingPool = gr.jackpotPoolSnapshot > gr.jackpotPaid ? gr.jackpotPoolSnapshot - gr.jackpotPaid : 0;
        if (requested > remainingPool) revert StaleJackpotChunk();

        uint256 paid = $.JACKPOT_TREASURY.payBatch(winners, amounts);
        emitJackpotPayments(roundId, address($.JACKPOT_TREASURY), winners, amounts, paid);
        gr.jackpotPaid += paid;
        gr.jackpotCursor += uint32(winners.length);
        if (gr.jackpotCursor >= gr.jackpotWinnerCount) gr.jackpotDistributed = true;
    }


    /// @dev Treasury caps sequentially; reconstruct actual rows from its returned total.
    function emitJackpotPayments(uint64 roundId, address treasury, address[] memory winners, uint256[] memory amounts, uint256 paid) private {
        address token = IJackpotTokenView(treasury).brb();
        for (uint256 i; i < winners.length && paid != 0; ++i) {
            uint256 actual = amounts[i] < paid ? amounts[i] : paid;
            if (actual != 0) emit JackpotPayment(roundId, winners[i], token, actual);
            paid -= actual;
        }
    }


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
    ) public view returns (address[] memory winners, uint256[] memory stakes, uint256 totalStake) {
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
