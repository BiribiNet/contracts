// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";
import { IRouletteBetErrors } from "../interfaces/IRouletteBetErrors.sol";
import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";

/// @notice Linked library: mask bets (`BET_MASK = 16`, `docs/spec-mask-bets-v1.md`).
/// @dev A mask leg covers an arbitrary set `S ⊂ {0..36}`, `2 ≤ |S| ≤ 35`, and pays `floor(amount × 36 / |S|)`
/// (stake included). Only the stake enters `lockedBetLiquidity` (through the vault's normal `placeBet`);
/// the payout liability lives exclusively in `roundMaskWeightedPayout` and never touches the vault NAV.
///
/// Leg encoding (`numbers[i]`, ABI of `betData` unchanged, every valid value `< 2^53`):
///   bits  0..36 mask (bit n ⇔ number n covered)
///   bits 37..45 presetId (informative, never read)
///   bit  46     guard (1 ⇒ require the previous round's winning number to equal `expectedPrev`)
///   bits 47..52 expectedPrev (0..36; must be 0 when guard = 0)
///   bits ≥ 53   must be zero
library RouletteMaskBetLib {
    uint256 internal constant BET_MASK = 16;

    uint256 internal constant NUMBER_COUNT = 37;
    uint256 internal constant MASK_BITS = (uint256(1) << 37) - 1;
    uint256 internal constant GUARD_SHIFT = 46;
    uint256 internal constant PREV_SHIFT = 47;
    uint256 internal constant PREV_BITS = 0x3f;
    uint256 internal constant ENCODING_BITS = 53;
    uint256 internal constant MAX_WINNING_NUMBER = 36;
    uint256 internal constant MIN_MASK_SIZE = 2;
    uint256 internal constant MAX_MASK_SIZE = 35;
    /// @dev Straight-up multiplier: a mask pays `36 / |S|` times its stake.
    uint256 internal constant PAYOUT_NUMERATOR = 36;
    uint256 internal constant COUNTER_BITS = 16;
    uint256 internal constant COUNTERS_PER_WORD = 16;
    uint256 internal constant COUNTER_MASK = 0xffff;
    /// @dev Hard bound for `maxMaskLegsPerMarketRound`: keeps every uint16 win counter from overflowing.
    uint256 internal constant MAX_LEGS_LIMIT = 0xffff;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error MaskBetsDisabled();
    error MaskLegBelowMinBet();
    error MaskLegCapExceeded();
    error PreviousOutcomeMismatch();
    error InvalidMaskBetLimits();

    event MaskBetLimitsUpdated(uint32 marketId, uint32 maxLegsPerRound, uint16 maxLiabilityBps);

    /// @dev Per-transaction cache: `minBet` and the previous outcome are read at most once per `recordBet`.
    struct LegContext {
        uint64 roundId;
        uint32 marketId;
        address player;
        uint256 minBet;
        bool previousLoaded;
        bool previousKnown;
        uint8 previousNumber;
        uint256 addedPayout;
        uint256[3] counts;
    }

    /// @notice Records every `BET_MASK` leg of one `recordBet` payload; classic legs are skipped.
    /// @dev Caller (the engine) has already summed every leg into the transaction total. Checks per leg:
    /// encoding/size, zero stake, `minBet` per leg, guard; then the per-market leg cap once for the batch.
    /// The liability cap is enforced by `RouletteLiabilityMathLib.assertSolventAfterBet` with the same
    /// free-liquidity figure as the solvency check.
    function recordMaskLegs(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address player,
        address bank,
        uint256[] memory betTypes,
        uint256[] memory numbers,
        uint256[] memory amounts
    ) external {
        uint32 maxLegs = $.maxMaskLegsPerMarketRound[marketId];
        if (maxLegs == 0) revert MaskBetsDisabled();

        LegContext memory ctx;
        ctx.roundId = roundId;
        ctx.marketId = marketId;
        ctx.player = player;
        ctx.minBet = IBankVault(bank).minBet();
        uint256[3] storage counters = $.roundMaskWinCounts[roundId][marketId];
        ctx.counts = [counters[0], counters[1], counters[2]];

        uint256 legCount = betTypes.length;
        for (uint256 i; i < legCount; ) {
            if (betTypes[i] == BET_MASK) _recordLeg($, ctx, numbers[i], amounts[i]);
            unchecked {
                ++i;
            }
        }

        if ($.roundMaskBets[roundId][marketId].length > maxLegs) revert MaskLegCapExceeded();
        counters[0] = ctx.counts[0];
        counters[1] = ctx.counts[1];
        counters[2] = ctx.counts[2];
        $.roundMaskWeightedPayout[roundId][marketId] += ctx.addedPayout;
    }

    function setMaskBetLimits(
        RouletteEngineStorageLib.Layout storage $,
        uint32 marketId,
        uint32 maxLegsPerRound,
        uint16 maxLiabilityBps
    ) external {
        // Reverts `InvalidMarketId` for an unregistered market.
        $.REGISTRY.getMarket(marketId);
        if (maxLegsPerRound > MAX_LEGS_LIMIT || maxLiabilityBps > BPS_DENOMINATOR) revert InvalidMaskBetLimits();
        $.maxMaskLegsPerMarketRound[marketId] = maxLegsPerRound;
        $.maxMaskLiabilityBps[marketId] = maxLiabilityBps;
        emit MaskBetLimitsUpdated(marketId, maxLegsPerRound, maxLiabilityBps);
    }

    /// @notice Decodes and validates one leg's `number` field.
    /// @return mask covered set (37 bits)
    /// @return size `|S|`, in `[2, 35]` (number 0 counts like any other covered number)
    /// @return guarded whether the previous-outcome guard is set
    /// @return expectedPrev required previous winning number (only meaningful when `guarded`)
    function decodeMaskLeg(uint256 numberRaw)
        internal
        pure
        returns (uint256 mask, uint256 size, bool guarded, uint256 expectedPrev)
    {
        if (numberRaw >> ENCODING_BITS != 0) revert IRouletteBetErrors.InvalidBetNumber();
        mask = numberRaw & MASK_BITS;
        size = popcount37(mask);
        if (size < MIN_MASK_SIZE || size > MAX_MASK_SIZE) revert IRouletteBetErrors.InvalidBetNumber();
        guarded = (numberRaw >> GUARD_SHIFT) & 1 == 1;
        expectedPrev = (numberRaw >> PREV_SHIFT) & PREV_BITS;
        if (!guarded && expectedPrev != 0) revert IRouletteBetErrors.InvalidBetNumber();
    }

    /// @dev One integer division, rounded down: never favourable to the player.
    function maskPayout(uint256 amount, uint256 size) internal pure returns (uint256) {
        return (amount * PAYOUT_NUMERATOR) / size;
    }

    function popcount37(uint256 mask) internal pure returns (uint256 count) {
        unchecked {
            while (mask != 0) {
                mask &= mask - 1;
                ++count;
            }
        }
    }

    /// @dev Win-counter for `winningNumber` (O(1), read at VRF fulfilment).
    function winCount(uint256[3] storage counters, uint8 winningNumber) internal view returns (uint256) {
        uint256 word = counters[winningNumber / COUNTERS_PER_WORD];
        return (word >> (COUNTER_BITS * (winningNumber % COUNTERS_PER_WORD))) & COUNTER_MASK;
    }

    function _recordLeg(
        RouletteEngineStorageLib.Layout storage $,
        LegContext memory ctx,
        uint256 numberRaw,
        uint256 amount
    ) private {
        if (amount == 0) revert IRouletteBetErrors.ZeroBetAmount();
        (uint256 mask, uint256 size, bool guarded, uint256 expectedPrev) = decodeMaskLeg(numberRaw);
        if (amount < ctx.minBet) revert MaskLegBelowMinBet();
        // `MaskBetEntry.amount` is uint128; refuse rather than truncate a (never realistic) larger stake.
        if (amount > type(uint128).max) revert IRouletteBetErrors.InvalidBetNumber();
        if (guarded) _checkPreviousOutcome($, ctx, expectedPrev);

        $.roundMaskBets[ctx.roundId][ctx.marketId].push(
            RouletteEngineStorageLib.MaskBetEntry({
                player: ctx.player,
                mask: uint40(mask),
                size: uint8(size),
                amount: uint128(amount)
            })
        );
        ctx.addedPayout += maskPayout(amount, size);
        _incrementCounters(ctx.counts, mask);
    }

    /// @dev Bets on round `r` are only accepted once `r − 1` is fully resolved, so its winning number is final.
    /// The outcome is loaded once per transaction and reused for every guarded leg.
    function _checkPreviousOutcome(
        RouletteEngineStorageLib.Layout storage $,
        LegContext memory ctx,
        uint256 expectedPrev
    ) private view {
        if (!ctx.previousLoaded) {
            ctx.previousLoaded = true;
            if (ctx.roundId > 1) {
                RouletteEngineStorageLib.GlobalRoundState storage previous = $.globalRoundState[ctx.roundId - 1];
                ctx.previousKnown = previous.vrfFulfilled;
                ctx.previousNumber = previous.winningNumber;
            }
        }
        if (!ctx.previousKnown || expectedPrev > MAX_WINNING_NUMBER || expectedPrev != ctx.previousNumber) {
            revert PreviousOutcomeMismatch();
        }
    }

    /// @dev Adds one to the uint16 counter of every covered number. No carry is possible: a counter is at
    /// most the round's mask-leg count, itself bounded by `maxMaskLegsPerMarketRound ≤ 65 535` (checked
    /// before the counters are written back).
    function _incrementCounters(uint256[3] memory counts, uint256 mask) private pure {
        unchecked {
            for (uint256 n; n < NUMBER_COUNT; ++n) {
                if ((mask >> n) & 1 == 1) {
                    counts[n / COUNTERS_PER_WORD] += uint256(1) << (COUNTER_BITS * (n % COUNTERS_PER_WORD));
                }
            }
        }
    }
}
