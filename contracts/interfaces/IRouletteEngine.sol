// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "./IBankVault.sol";

interface IRouletteEngine {
    enum JobKind {
        None,
        OpenRound,
        PreLock,
        TriggerVrf,
        Payout
    }

    /// @notice For `JobKind.Payout` when parallel payout lanes are enabled: `payoutShardIndex`/`payoutShardWidth`
    /// select a deterministic slice of winners; `type(uint32).max` shard index is reserved for jackpot-only steps.
    struct Job {
        JobKind kind;
        uint32 marketId;
        uint64 roundId;
        uint32 nextCursor;
        uint32 payoutShardIndex;
        uint32 payoutShardWidth;
    }

    function registerScheduler(address scheduler, bool allowed) external;

    /// @notice Registry-only market registration hook (e.g. `MarketRegistry.createMarket`).
    function registerMarketFromRegistry(uint32 marketId, address bank) external;

    function recordBet(
        uint32 marketId,
        address player,
        uint256 amount,
        bytes calldata betData
    ) external;

    function payoutParallelLaneCount() external view returns (uint32);

    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit
    ) external view returns (bool found, Job memory job);

    /// @notice Like `findNextJob` but routes payout shards to lane `payoutLane % payoutParallelLaneCount` when lanes & width are active.
    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit,
        uint32 payoutLane,
        uint32 payoutShardWidth
    ) external view returns (bool found, Job memory job);

    /// @param winnerPayoutRows Precomputed slice from Automation `checkUpkeep` (`previewWinnerPayoutBundle`).
    /// Empty = build payouts on-chain. Non-empty trusts DON + scheduler; engine bounds `winnerPayoutRows.length <= chunk`.
    function executeJob(Job memory job, uint32 maxPayoutsPerCall, IBankVault.Payout[] memory winnerPayoutRows)
        external
        returns (bool didWork);

    /// @notice `checkUpkeep`/`eth_call` helper: materializes payout rows for the next winner slice when applicable (else empty array).
    function previewWinnerPayoutBundle(Job memory job, uint32 maxPayoutsPerCall)
        external
        view
        returns (IBankVault.Payout[] memory payouts);

    function currentGlobalRound() external view returns (uint64);

    function hasPendingVrf() external view returns (bool);

    function vrfActiveRound() external view returns (uint64);

    function vrfActiveMarket() external view returns (uint32);

    function pushPayouts(
        uint32 marketId,
        uint64 roundId,
        IBankVault.Payout[] calldata payouts
    ) external;

    /// @notice True while this market's global round is sealed but not yet settled for that market (deposits / enqueue-withdraw blocked).
    function isBankLiquidityRestricted(uint32 marketId) external view returns (bool);

    /// @notice Max withdrawal queue entries to finalize per settlement step for any bank (shared across markets).
    function withdrawalQueueBatchSize() external view returns (uint256);

    /// @notice Max pending withdrawal queue length per bank (shared cap across markets).
    function maxWithdrawalQueueLength() external view returns (uint256);
}
