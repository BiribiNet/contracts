// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "./IBankVault.sol";

interface IRouletteEngine {
    enum JobKind {
        None,
        PreLock,
        TriggerVrf,
        Payout
    }

    /// @notice For `JobKind.Payout`, `payoutShardIndex` is the automation lane and `payoutShardWidth` is `payoutParallelLaneCount`.
    /// Vault winners are sharded by global winner index (`index % width`); all lanes may service the same market.
    struct Job {
        JobKind kind;
        uint32 marketId;
        uint64 roundId;
        uint32 nextCursor;
        uint32 payoutShardIndex;
        uint32 payoutShardWidth;
    }

    /// @notice Registry-only market registration hook (e.g. `MarketRegistry.createMarket`).
    function registerMarketFromRegistry(uint32 marketId, address bank) external;

    function recordBet(
        uint32 marketId,
        address player,
        uint256 amount,
        bytes calldata betData,
        address referral
    ) external;

    function payoutParallelLaneCount() external view returns (uint32);

    /// @notice `payoutLane` is the automation lane id; `payoutShardWidth` must be zero (width is set on the returned job).
    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit,
        uint32 payoutLane,
        uint32 payoutShardWidth
    ) external view returns (bool found, Job memory job);

    /// @notice Whether this automation lane should run `performUpkeep` for a `Payout` job (false = no on-chain tx).
    function payoutLaneHasWork(Job memory job) external view returns (bool);

    /// @notice Simulation-only: builds the exact payout rows for `checkUpkeep` (no storage writes).
    function previewPayoutBundle(Job memory job, uint32 maxPayoutsPerCall)
        external
        view
        returns (
            IBankVault.Payout[] memory winnerPayoutRows,
            address[] memory jackpotWinners,
            uint256[] memory jackpotAmounts
        );

    /// @notice Apply-only path for Automation: rows must match the latest `previewPayoutBundle` for `job` (trusted scheduler).
    /// @param winnerPayoutRows Vault winner rows from `previewPayoutBundle` (may be empty when only jackpot chunk applies).
    /// @param jackpotWinners BRB jackpot recipients from `previewPayoutBundle` (may be empty).
    /// @param jackpotAmounts BRB amounts aligned with `jackpotWinners`.
    function executeJob(
        Job memory job,
        IBankVault.Payout[] memory winnerPayoutRows,
        address[] memory jackpotWinners,
        uint256[] memory jackpotAmounts
    ) external returns (bool didWork);

    function currentGlobalRound() external view returns (uint64);

    function referrerOf(address player) external view returns (address);

    /// @notice Outcome for a completed global round (`vrfFulfilled` must be true before `winningNumber` is authoritative).
    function roundOutcome(uint64 roundId) external view returns (bool vrfFulfilled, uint8 winningNumber);

    /// @notice Jackpot draw flag for a global round (`jackpotTriggered` is authoritative only when `vrfFulfilled` is true).
    function roundJackpotTriggered(uint64 roundId) external view returns (bool vrfFulfilled, bool jackpotTriggered);

    function hasPendingVrf() external view returns (bool);

    function vrfActiveRound() external view returns (uint64);

    /// @notice True while this market's global round is locked but not yet settled for that market (deposits / enqueue-withdraw blocked).
    function isBankLiquidityRestricted(uint32 marketId) external view returns (bool);

    /// @notice Max withdrawal queue entries to finalize per settlement step for any bank (shared across markets).
    function withdrawalQueueBatchSize() external view returns (uint256);

    /// @notice Max pending withdrawal queue length per bank (shared cap across markets).
    function maxWithdrawalQueueLength() external view returns (uint256);
}
