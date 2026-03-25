// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IRoulette {
    struct PayoutInfo {
        address player;
        uint256 payout;
    }

    function bet(address player, uint256 amount, bytes calldata data) external returns (uint256);

    /// @notice Called by StakedBRB when cleaning upkeep completes; aligns round boundary for timing views.
    function onRoundBoundary(uint256 boundaryTimestamp) external;

    function gamePeriod() external view returns (uint256);

    /// @notice True when betting is allowed (open window, not in lock, not during round transition on StakedBRB).
    function isBettingOpen() external view returns (bool);
}