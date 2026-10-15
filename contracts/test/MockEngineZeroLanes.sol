// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";

/// @dev Minimal engine for {UpkeepScheduler} `laneCount == 0` normalization branch.
contract MockEngineZeroLanes {
    function payoutParallelLaneCount() external pure returns (uint32) {
        return 0;
    }

    function findNextJob(uint32, uint32, uint32, uint32)
        external
        pure
        returns (bool found, IRouletteEngine.Job memory job)
    {
        return (false, job);
    }

    function payoutLaneHasWork(IRouletteEngine.Job memory) external pure returns (bool) {
        return false;
    }
}
