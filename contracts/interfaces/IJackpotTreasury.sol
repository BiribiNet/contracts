// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IJackpotTreasury {
    function setEngine(address engine) external;

    function registerMarket(uint32 marketId, address assetToken) external;

    /// @notice Transfers all jackpot balances (across all registered market assets) to `winner`.
    /// @return paid Sum of transferred amounts across assets (telemetry only).
    function payFullJackpot(address winner) external returns (uint256 paid);

    function jackpotPool() external view returns (uint256);
}
