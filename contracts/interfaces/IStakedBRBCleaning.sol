// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Cleaning automation runs via {BRBUpkeepManager}; this is the callback surface on StakedBRB.
interface IStakedBRBCleaning {
    function checkCleaningUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData);

    function executeCleaningUpkeep(bytes calldata performData) external;
}
