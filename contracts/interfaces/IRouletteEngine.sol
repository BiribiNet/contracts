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

    struct Job {
        JobKind kind;
        uint32 marketId;
        uint64 roundId;
        uint32 nextCursor;
    }

    function registerScheduler(address scheduler, bool allowed) external;

    function registerMarket(uint32 marketId, address bank) external;

    function recordBet(
        uint32 marketId,
        address player,
        uint256 amount,
        bytes calldata betData
    ) external;

    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit
    ) external view returns (bool found, Job memory job);

    function executeJob(Job memory job, uint32 maxPayoutsPerCall) external returns (bool didWork);

    function currentGlobalRound() external view returns (uint64);

    function hasPendingVrf() external view returns (bool);

    function vrfActiveRound() external view returns (uint64);

    function vrfActiveMarket() external view returns (uint32);

    function pushPayouts(
        uint32 marketId,
        uint64 roundId,
        IBankVault.Payout[] calldata payouts
    ) external;
}
