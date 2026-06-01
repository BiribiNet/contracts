// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngine } from "../RouletteEngine.sol";
import { RouletteEngineStorageLib } from "../libraries/RouletteEngineStorageLib.sol";

/// @dev Test helper to force storage edge cases (e.g. `payoutLaneCount == 0`).
contract RouletteEngineHarness is RouletteEngine {
    constructor(
        address vrfCoordinator,
        bytes32 vrfKeyHash2Gwei,
        bytes32 vrfKeyHash30Gwei,
        bytes32 vrfKeyHash150Gwei,
        uint16 vrfConfirmations,
        address brbReferral
    ) RouletteEngine(vrfCoordinator, vrfKeyHash2Gwei, vrfKeyHash30Gwei, vrfKeyHash150Gwei, vrfConfirmations, brbReferral) {}

    function harnessSetPayoutLaneCount(uint32 laneCount) external {
        RouletteEngineStorageLib.layout().payoutLaneCount = laneCount;
    }

    function harnessIsRoundDone(uint64 roundId) external view returns (bool) {
        return _isRoundDone(RouletteEngineStorageLib.layout(), roundId);
    }

    function harnessSetRoundMarketParticipantCount(uint64 roundId, uint32 count) external {
        RouletteEngineStorageLib.layout()._roundMarketParticipantCount[roundId] = count;
    }

    function harnessClearRoundLockAt(uint64 roundId) external {
        RouletteEngineStorageLib.layout()._roundLockAt[roundId] = 0;
    }

    function harnessSetRoundLockAt(uint64 roundId, uint256 lockAt) external {
        RouletteEngineStorageLib.layout()._roundLockAt[roundId] = lockAt;
    }

    function harnessSetJackpotCursor(uint64 roundId, uint32 cursor) external {
        RouletteEngineStorageLib.layout().globalRoundState[roundId].jackpotCursor = cursor;
    }

    function harnessSetJackpotPreviewState(uint64 roundId, bool triggered, bool distributed, uint32 cursor) external {
        RouletteEngineStorageLib.GlobalRoundState storage gr = RouletteEngineStorageLib.layout().globalRoundState[roundId];
        gr.jackpotTriggered = triggered;
        gr.jackpotDistributed = distributed;
        gr.jackpotCursor = cursor;
    }

    function harnessPreviewPayoutBundle(Job memory job, uint32 maxPayoutsPerCall) external {
        _previewPayoutBundle(job, maxPayoutsPerCall);
    }

    function harnessPayoutLaneHasWork(Job memory job) external {
        _payoutLaneHasWork(job);
    }

    function harnessTriggerVrf() external {
        _triggerVrf();
    }
}
