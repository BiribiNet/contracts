// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";
import { RouletteBetLib } from "./RouletteBetLib.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { RoulettePayoutMulLib } from "./RoulettePayoutMulLib.sol";

/// @dev Linked library: flattened winner-stream traversal for payout preview (offloads `RouletteEngine`).
library RoulettePayoutSweepLib {
    struct PayoutSweepCtx {
        uint64 rid;
        uint32 mid;
        uint256 cursorStart;
        uint256 payoutMax;
        uint256 gPos;
        uint256 payoutCount;
        uint32 shardIndex;
        uint32 shardWidth;
        uint256 shardSeen;
    }

    function snapshotRoundMarketWinningCounts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber
    ) external {
        uint32 totalMarkets = $.REGISTRY.marketCount();
        for (uint32 mid = 1; mid <= totalMarkets; ) {
            if (!$._roundHasMarket[roundId][mid]) {
                unchecked {
                    ++mid;
                }
                continue;
            }
            RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][mid];
            if (mr.totals.betCount > 0) {
                RouletteBetLib.WinningBetTypes memory wt = RouletteBetLib.getWinningBetTypes(winningNumber);
                snapshotMarketWinningShardCounts($, roundId, mid, winningNumber, wt);
                mr.bankPaidRunning = 0;
            }
            unchecked {
                ++mid;
            }
        }
    }

    function snapshotMarketWinningShardCounts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        RouletteBetLib.WinningBetTypes memory wt
    ) public {
        uint32 laneCount = $.payoutLaneCount;
        if (laneCount == 0) laneCount = 1;

        uint256[] memory shards = new uint256[](laneCount);
        uint256 gPos;
        gPos = _accumulateBucketShards(
            $,
            roundId,
            marketId,
            $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Straight)][winningNumber],
            gPos,
            shards,
            laneCount
        );
        for (uint256 j; j < wt.winningSplits.length; ) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Split)][wt.winningSplits[j]],
                gPos,
                shards,
                laneCount
            );
            unchecked {
                ++j;
            }
        }
        if (wt.winningStreet != 0) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Street)][wt.winningStreet],
                gPos,
                shards,
                laneCount
            );
        }
        for (uint256 j2; j2 < wt.winningCorners.length; ) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Corner)][wt.winningCorners[j2]],
                gPos,
                shards,
                laneCount
            );
            unchecked {
                ++j2;
            }
        }
        for (uint256 j3; j3 < wt.winningLines.length; ) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Line)][wt.winningLines[j3]],
                gPos,
                shards,
                laneCount
            );
            unchecked {
                ++j3;
            }
        }
        if (wt.winningColumn != 0) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Column)][wt.winningColumn],
                gPos,
                shards,
                laneCount
            );
        }
        if (wt.winningDozen != 0) {
            gPos = _accumulateBucketShards(
                $,
                roundId,
                marketId,
                $.roundNumberedBets[roundId][marketId][uint8(RouletteEngineStorageLib.NumberedBetBucket.Dozen)][wt.winningDozen],
                gPos,
                shards,
                laneCount
            );
        }
        if (wt.red) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Red)], gPos, shards, laneCount
            );
        }
        if (wt.black) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Black)], gPos, shards, laneCount
            );
        }
        if (wt.odd) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Odd)], gPos, shards, laneCount
            );
        }
        if (wt.even) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Even)], gPos, shards, laneCount
            );
        }
        if (wt.low) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Low)], gPos, shards, laneCount
            );
        }
        if (wt.high) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.High)], gPos, shards, laneCount
            );
        }
        if (wt.trio012) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Trio012)], gPos, shards, laneCount
            );
        }
        if (wt.trio023) {
            gPos = _accumulateBucketShards(
                $, roundId, marketId, $.roundFlatBets[roundId][marketId][uint8(RouletteEngineStorageLib.FlatBetBucket.Trio023)], gPos, shards, laneCount
            );
        }

        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        uint256 total;
        for (uint32 lane; lane < laneCount; ) {
            $.winningBetCountByShard[roundId][marketId][lane] = shards[lane];
            total += shards[lane];
            unchecked {
                ++lane;
            }
        }
        mr.winningBetCount = total;
    }

    function _accumulateBucketShards(
        RouletteEngineStorageLib.Layout storage,
        uint64,
        uint32,
        RouletteEngineStorageLib.BetEntry[] storage bucket,
        uint256 gPos,
        uint256[] memory shards,
        uint32 laneCount
    ) private view returns (uint256) {
        uint256 len = bucket.length;
        unchecked {
            for (uint256 i; i < len; ) {
                shards[gPos % laneCount]++;
                ++gPos;
                ++i;
            }
        }
        return gPos;
    }

    function previewWinningPayoutsSlice(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint256 cursorStart,
        uint256 maxPayouts,
        uint256 batchCapacity,
        uint32 shardIndex,
        uint32 shardWidth
    ) external view returns (IBankVault.Payout[] memory out, uint256 written, uint256 nextCursor, uint256 bankPaidSum) {
        RouletteBetLib.WinningBetTypes memory wt = RouletteBetLib.getWinningBetTypes(winningNumber);
        out = new IBankVault.Payout[](batchCapacity);

        PayoutSweepCtx memory c;
        c.rid = roundId;
        c.mid = marketId;
        c.cursorStart = cursorStart;
        c.payoutMax = maxPayouts;
        c.shardIndex = shardIndex;
        c.shardWidth = shardWidth;

        c = _sweepStraight($, c, out, winningNumber);
        c = _sweepSplits($, c, out, wt);
        c = _sweepStreet($, c, out, wt);
        c = _sweepCorners($, c, out, wt);
        c = _sweepLines($, c, out, wt);
        c = _sweepColumn($, c, out, wt);
        c = _sweepDozen($, c, out, wt);
        c = _sweepFlats($, c, out, wt);

        written = c.payoutCount;
        assembly {
            mstore(out, written)
        }
        unchecked {
            for (uint256 i; i < written; ) {
                bankPaidSum += out[i].amount;
                ++i;
            }
            nextCursor = cursorStart + written;
        }
    }

    function _sweepStraight(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        uint8 winningNumber
    ) private view returns (PayoutSweepCtx memory) {
        return _consumeBucket(
            c,
            out,
            $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Straight)][winningNumber]
        );
    }

    function _sweepSplits(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        for (uint256 j; c.payoutCount < c.payoutMax && j < wt.winningSplits.length; ) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Split)][wt.winningSplits[j]]
            );
            unchecked {
                ++j;
            }
        }
        return c;
    }

    function _sweepStreet(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        if (c.payoutCount < c.payoutMax && wt.winningStreet != 0) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Street)][wt.winningStreet]
            );
        }
        return c;
    }

    function _sweepCorners(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        for (uint256 j; c.payoutCount < c.payoutMax && j < wt.winningCorners.length; ) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Corner)][wt.winningCorners[j]]
            );
            unchecked {
                ++j;
            }
        }
        return c;
    }

    function _sweepLines(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        for (uint256 j; c.payoutCount < c.payoutMax && j < wt.winningLines.length; ) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Line)][wt.winningLines[j]]
            );
            unchecked {
                ++j;
            }
        }
        return c;
    }

    function _sweepColumn(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        if (c.payoutCount < c.payoutMax && wt.winningColumn != 0) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Column)][wt.winningColumn]
            );
        }
        return c;
    }

    function _sweepDozen(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        if (c.payoutCount < c.payoutMax && wt.winningDozen != 0) {
            c = _consumeBucket(
                c,
                out,
                $.roundNumberedBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.NumberedBetBucket.Dozen)][wt.winningDozen]
            );
        }
        return c;
    }

    function _sweepFlats(
        RouletteEngineStorageLib.Layout storage $,
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (PayoutSweepCtx memory) {
        if (c.payoutCount < c.payoutMax && wt.red) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Red)]);
        }
        if (c.payoutCount < c.payoutMax && wt.black) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Black)]);
        }
        if (c.payoutCount < c.payoutMax && wt.odd) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Odd)]);
        }
        if (c.payoutCount < c.payoutMax && wt.even) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Even)]);
        }
        if (c.payoutCount < c.payoutMax && wt.low) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Low)]);
        }
        if (c.payoutCount < c.payoutMax && wt.high) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.High)]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio012) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Trio012)]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio023) {
            c = _consumeBucket(c, out, $.roundFlatBets[c.rid][c.mid][uint8(RouletteEngineStorageLib.FlatBetBucket.Trio023)]);
        }
        return c;
    }

    function _consumeBucket(
        PayoutSweepCtx memory c,
        IBankVault.Payout[] memory out,
        RouletteEngineStorageLib.BetEntry[] storage bucket
    ) private view returns (PayoutSweepCtx memory) {
        uint256 len = bucket.length;
        unchecked {
            RouletteEngineStorageLib.BetEntry storage bet;
            uint256 gi;
            bool pay;
            for (uint256 i; i < len; ) {
                gi = c.gPos + i;
                pay = true;
                if (c.shardWidth > 1) {
                    if (gi % c.shardWidth != c.shardIndex) {
                        pay = false;
                    } else if (c.shardSeen < c.cursorStart) {
                        c.shardSeen++;
                        pay = false;
                    } else {
                        c.shardSeen++;
                    }
                } else if (gi < c.cursorStart) {
                    pay = false;
                }
                if (pay && c.payoutCount < c.payoutMax) {
                    bet = bucket[i];
                    out[c.payoutCount] = IBankVault.Payout(
                        bet.player, RoulettePayoutMulLib.payoutForAmount(bet.betType, uint256(bet.amount))
                    );
                    c.payoutCount++;
                }
                ++i;
            }
            c.gPos += len;
        }
        return c;
    }
}
