// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice {SideBet} hooks on {BankVault4626}. Settlement uses shared `releaseBets` / `payoutBatch` / `transferOut`.
interface ISideBetVault {
    function sideBetController() external view returns (address);

    /// @dev Free LP liquidity (`totalAssets`) before a new side-bet stake is credited.
    function availableForSideBet() external view returns (uint256);

    /// @notice Pull `stake` from `player` and lock `payoutReserve` in `lockedBetLiquidity`.
    function lockSideBetStake(address player, uint256 stake, uint256 payoutReserve) external;
}
