// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IMarketRegistry {
    struct MarketConfig {
        address asset;
        address bank;
        uint32 roundDuration;
        uint32 maxBetsPerRound;
        bool enabled;
    }

    function registerMarket(
        address asset,
        address bank,
        uint32 roundDuration,
        uint32 maxBetsPerRound
    ) external returns (uint32 marketId);

    function setMarketEnabled(uint32 marketId, bool enabled) external;

    function marketCount() external view returns (uint32);

    function getMarket(uint32 marketId) external view returns (MarketConfig memory config);
}
