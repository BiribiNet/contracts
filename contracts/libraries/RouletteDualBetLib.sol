// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteBetErrors } from "../interfaces/IRouletteBetErrors.sol";
import { RouletteDualBetRules as Rules } from "./RouletteDualBetRules.sol";
import { RouletteEngineStorageLib as Storage } from "./RouletteEngineStorageLib.sol";

library RouletteDualBetLib {
    // The combined scan budget preserves headroom for the last keeper preview.
    // A dual entry uses two work units versus one for a v1 mask entry.
    uint256 private constant MAX_SCAN_WORK = 448;
    error DualBetDisabled();
    error DualLegBelowMinBet();
    error DualLegCapExceeded();
    error InvalidDualBetLimits();
    error DualRoundCapacityExceeded();

    event DualBetLimitsUpdated(uint32 marketId, uint32 maxLegs, uint16 liabilityBps, uint8 enabledVariants);

    function setLimits(
        Storage.Layout storage $,
        uint32 marketId,
        uint32 maxLegs,
        uint16 liabilityBps,
        uint8 enabledVariants
    ) internal {
        $.REGISTRY.getMarket(marketId);
        if (maxLegs > MAX_SCAN_WORK / 2 || liabilityBps > 10_000) revert InvalidDualBetLimits();
        $.dualBetLimits[marketId] = Storage.DualLimits(maxLegs, liabilityBps, enabledVariants);
        emit DualBetLimitsUpdated(marketId, maxLegs, liabilityBps, enabledVariants);
    }

    function checkCombinedCapacity(uint256 masks, uint256 dual) internal pure {
        if (dual != 0 && masks + 2 * dual > MAX_SCAN_WORK) revert DualRoundCapacityExceeded();
    }

    function record(
        Storage.DualRound storage round,
        Storage.DualLimits memory limits,
        address player,
        uint256 minBet,
        uint256 raw,
        uint256 amount
    ) internal {
        Rules.Selection memory selection = Rules.decode(raw);
        if (limits.maxLegs == 0 || limits.liabilityBps == 0 || (limits.enabledVariants >> selection.variant) & 1 == 0) {
            revert DualBetDisabled();
        }
        if (round.bets.length >= limits.maxLegs) revert DualLegCapExceeded();
        if (amount == 0) revert IRouletteBetErrors.ZeroBetAmount();
        if (amount < minBet) revert DualLegBelowMinBet();
        if (amount > type(uint128).max) revert IRouletteBetErrors.InvalidBetNumber();
        (uint256 wins, uint256 refunds) = Rules.odds(selection);
        uint256 numerator = Rules.PAYOUT_BUDGET - refunds;
        round.weightedPayout += amount * numerator / wins;
        round.bets.push(Storage.DualBetEntry(
            player, selection.rouletteMask, selection.jackpotMask, selection.variant,
            uint128(amount), uint16(numerator), uint16(wins)
        ));
        _addCounts(round, selection);
    }

    function _addCounts(Storage.DualRound storage round, Rules.Selection memory selection) private {
        uint8 variant = selection.variant;
        if (variant < Rules.DOUBLE_MASK || variant == Rules.DOUBLE_ZERO) {
            ++round.fixedCounts[variant];
            return;
        }
        bool refund = variant == Rules.REFUND_MASK;
        uint40 jackpotMask = variant == Rules.EXACT_PAIR ? selection.rouletteMask : selection.jackpotMask;
        uint8[4] memory jackpotPockets;
        uint256 jackpotSize;
        for (uint8 j; j < Rules.POCKETS; ++j) {
            if (Rules.covers(jackpotMask, j)) {
                jackpotPockets[jackpotSize++] = j;
                if (refund) ++round.refundJackpot[j];
            }
        }
        for (uint8 r; r < Rules.POCKETS; ++r) {
            if (!Rules.covers(selection.rouletteMask, r)) continue;
            if (refund) ++round.refundRoulette[r];
            for (uint256 i; i < jackpotSize; ++i) {
                uint8 j = jackpotPockets[i];
                if (variant == Rules.EXACT_PAIR && r == j) continue;
                uint256 pair = uint256(r) * Rules.POCKETS + j;
                if (refund) ++round.refundMaskPairs[pair];
                else ++round.winningPairs[pair];
            }
        }
    }

    function paymentCount(Storage.DualRound storage round, uint8 r, uint8 j) internal view returns (uint256 count) {
        if (round.bets.length == 0) return 0;
        uint256 pair = uint256(r) * Rules.POCKETS + j;
        count = uint256(round.winningPairs[pair]) + round.refundRoulette[r] + round.refundJackpot[j]
            - round.refundMaskPairs[pair];
        for (uint8 variant; variant < Rules.DOUBLE_MASK; ++variant) {
            if (Rules.fixedWins(variant, r, j)) count += round.fixedCounts[variant];
        }
        if (r == 0 && j == 0) count += round.fixedCounts[Rules.DOUBLE_ZERO];
    }
}
