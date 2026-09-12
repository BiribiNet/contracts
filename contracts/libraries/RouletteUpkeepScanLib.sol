// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";
import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";
import { JackpotBatchLib } from "./JackpotBatchLib.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { RouletteJackpotCollectLib } from "./RouletteJackpotCollectLib.sol";
import { RoulettePayoutSweepLib } from "./RoulettePayoutSweepLib.sol";

/// @dev Linked library: job scan + payout preview (offloads `RouletteEngine` under EIP-170).
library RouletteUpkeepScanLib {
    function findNextJob(
        RouletteEngineStorageLib.Layout storage $,
        uint32 startCursor,
        uint32 payoutLane
    ) external view returns (bool found, IRouletteEngine.Job memory job) {
        uint32 totalMarkets = $.REGISTRY.marketCount();
        if (totalMarkets == 0) return (false, job);

        uint32 laneCount = $.payoutLaneCount;
        if (laneCount == 0) laneCount = 1;
        if (payoutLane >= laneCount) return (false, job);

        (found, job) = _findPayoutJobForLane($, payoutLane, laneCount);
        if (found) return (true, job);
        if (payoutLane != 0) return (false, job);

        uint64 roundId = $._globalRound;
        if (!_vrfTriggerUpkeepCandidate($, roundId)) return (false, job);
        return (
            true,
            IRouletteEngine.Job({
                kind: IRouletteEngine.JobKind.TriggerVrf,
                marketId: 0,
                roundId: roundId,
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            })
        );
    }

    function payoutLaneHasWork(RouletteEngineStorageLib.Layout storage $, IRouletteEngine.Job memory job)
        external
        view
        returns (bool)
    {
        return _payoutLaneHasWork($, job);
    }

    function previewPayoutBundle(
        RouletteEngineStorageLib.Layout storage $,
        IRouletteEngine.Job memory job,
        uint32 maxPayoutsPerCall
    )
        external
        view
        returns (
            IBankVault.Payout[] memory winnerPayoutRows,
            address[] memory jackpotWinners,
            uint256[] memory jackpotAmounts
        )
    {
        if (job.kind != IRouletteEngine.JobKind.Payout || maxPayoutsPerCall == 0 || job.payoutShardWidth == 0) {
            return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
        }
        return _previewPayoutBundleShard(
            $, job.roundId, job.marketId, job.payoutShardIndex, job.payoutShardWidth, maxPayoutsPerCall
        );
    }

    function allPayoutShardsComplete(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint32 laneCount
    ) external view returns (bool) {
        return _allPayoutShardsComplete($, roundId, marketId, laneCount);
    }

    function _findPayoutJobForLane(
        RouletteEngineStorageLib.Layout storage $,
        uint32 payoutLane,
        uint32 laneCount
    ) private view returns (bool found, IRouletteEngine.Job memory job) {
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Settling) return (false, job);

        uint64 roundId = $._globalRound;
        if (!$.globalRoundState[roundId].vrfFulfilled) return (false, job);

        uint32 totalMarkets = $.REGISTRY.marketCount();
        for (uint32 marketId = 1; marketId <= totalMarkets; ) {
            RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
            if (!mr.settled && mr.totals.betCount > 0) {
                IRouletteEngine.Job memory candidate = IRouletteEngine.Job({
                    kind: IRouletteEngine.JobKind.Payout,
                    marketId: marketId,
                    roundId: roundId,
                    nextCursor: uint32($.payoutCursorByShard[roundId][marketId][payoutLane]),
                    payoutShardIndex: payoutLane,
                    payoutShardWidth: laneCount
                });
                if (_payoutLaneHasWork($, candidate)) return (true, candidate);
            }
            unchecked {
                ++marketId;
            }
        }
        return (false, job);
    }

    function _vrfTriggerUpkeepCandidate(RouletteEngineStorageLib.Layout storage $, uint64 roundId)
        private
        view
        returns (bool)
    {
        if ($._pendingRequestId != 0) return false;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) return false;
        if ($.globalRoundState[roundId].vrfRequested) return false;
        uint32 triggerMarketId = $._roundTriggerMarket[roundId];
        if (triggerMarketId == 0) return false;
        uint256 lockAt = $._roundLockAt[roundId];
        if (lockAt == 0 || block.timestamp < lockAt) return false;
        return $.marketRoundStateByRound[roundId][triggerMarketId].totals.betCount > 0;
    }

    function _payoutLaneHasWork(RouletteEngineStorageLib.Layout storage $, IRouletteEngine.Job memory job)
        private
        view
        returns (bool)
    {
        if (job.kind != IRouletteEngine.JobKind.Payout || job.payoutShardWidth == 0) return false;
        uint32 lane = job.payoutShardIndex;
        uint32 laneCount = job.payoutShardWidth;
        if (lane >= laneCount) return false;

        uint64 roundId = job.roundId;
        uint32 marketId = job.marketId;
        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        if (mr.settled) return false;

        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        if (!gr.vrfFulfilled) return false;

        if ($.payoutCursorByShard[roundId][marketId][lane] < $.winningBetCountByShard[roundId][marketId][lane]) {
            return true;
        }

        if (lane == 0 && gr.jackpotTriggered && !gr.jackpotDistributed && marketId == $._roundTriggerMarket[roundId]) {
            (address[] memory winners,, uint256 totalStake) =
                RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, gr.winningNumber);
            if (totalStake > 0 && uint256(gr.jackpotCursor) < winners.length) return true;
        }

        return lane == 0 && mr.winningBetCount == 0 && _allPayoutShardsComplete($, roundId, marketId, laneCount);
    }

    function _previewPayoutBundleShard(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint32 lane,
        uint32 laneCount,
        uint32 maxPayoutsPerCall
    )
        private
        view
        returns (
            IBankVault.Payout[] memory winnerPayoutRows,
            address[] memory jackpotWinners,
            uint256[] memory jackpotAmounts
        )
    {
        if (lane >= laneCount) return (winnerPayoutRows, jackpotWinners, jackpotAmounts);

        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        if (!gr.vrfFulfilled) return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
        if ($.marketRoundStateByRound[roundId][marketId].settled) {
            return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
        }

        if (lane == 0 && gr.jackpotTriggered && !gr.jackpotDistributed && marketId == $._roundTriggerMarket[roundId]) {
            (jackpotWinners, jackpotAmounts) = _previewJackpotPayouts($, roundId, gr.winningNumber, maxPayoutsPerCall);
        }

        winnerPayoutRows = _previewVaultShardPayouts($, roundId, marketId, gr.winningNumber, lane, laneCount, maxPayoutsPerCall);
    }

    function _previewVaultShardPayouts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint32 lane,
        uint32 laneCount,
        uint32 maxPayoutsPerCall
    ) private view returns (IBankVault.Payout[] memory rows) {
        uint256 shardTotal = $.winningBetCountByShard[roundId][marketId][lane];
        if (shardTotal == 0) return rows;

        uint256 start = $.payoutCursorByShard[roundId][marketId][lane];
        if (start >= shardTotal) return rows;

        uint256 chunk = shardTotal - start > uint256(maxPayoutsPerCall)
            ? uint256(maxPayoutsPerCall)
            : shardTotal - start;

        (rows,,,) = RoulettePayoutSweepLib.previewWinningPayoutsSlice(
            $, roundId, marketId, winningNumber, start, chunk, chunk, lane, laneCount
        );
    }

    function _previewJackpotPayouts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber,
        uint32 maxPayoutsPerCall
    ) private view returns (address[] memory jackpotWinners, uint256[] memory jackpotAmounts) {
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        (address[] memory winners, uint256[] memory stakes, uint256 totalStake) =
            RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, winningNumber);
        uint256 n = winners.length;
        if (n == 0) return (jackpotWinners, jackpotAmounts);

        uint256 pool0 = gr.jackpotPoolSnapshot;
        if (pool0 == 0) pool0 = $.JACKPOT_TREASURY.jackpotPool();
        uint256 denom = gr.jackpotTotalStake;
        if (denom == 0) denom = totalStake;
        // Defence in depth: with no eligible stake weight the proportional share is undefined.
        // Skip distribution rather than divide by zero (mirrors `_payoutLaneHasWork`'s totalStake > 0 gate).
        if (denom == 0) return (jackpotWinners, jackpotAmounts);

        uint256 start = uint256(gr.jackpotCursor);
        if (start >= n) return (jackpotWinners, jackpotAmounts);

        uint256 chunk = n - start > uint256(maxPayoutsPerCall) ? uint256(maxPayoutsPerCall) : n - start;
        JackpotBatchLib.JackpotComputeArgs memory args = JackpotBatchLib.JackpotComputeArgs({
            winners: winners,
            stakes: stakes,
            n: n,
            start: start,
            chunk: chunk,
            pool0: pool0,
            denom: denom,
            paidBefore: gr.jackpotPaid
        });
        (jackpotWinners, jackpotAmounts,,) = JackpotBatchLib.computeBatch(args);
    }

    function _allPayoutShardsComplete(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint32 laneCount
    ) private view returns (bool) {
        for (uint32 lane; lane < laneCount; ) {
            if ($.payoutCursorByShard[roundId][marketId][lane] < $.winningBetCountByShard[roundId][marketId][lane]) {
                return false;
            }
            unchecked {
                ++lane;
            }
        }
        return true;
    }
}
