// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IMarketRegistry {
    struct MarketConfig {
        address asset;
        address bank;
    }

    struct CreateMarketParams {
        address asset;
        string bankName;
        string bankSymbol;
        address bankAdmin;
    }

    /// @notice Next market id that will be assigned on registration.
    function previewNextMarketId() external view returns (uint32);

    /// @notice Beacon used for all vault proxies.
    function vaultBeacon() external view returns (address);

    /// @notice Sets the beacon used for vault proxies.
    function setVaultBeacon(address newBeacon) external;

    /// @notice Engine used for all created markets.
    function ENGINE() external view returns (address);

    /// @notice Sets the engine used for all created markets.
    function setEngine(address newEngine) external;

    /// @notice Creates a new market vault (proxy) and registers it.
    function createMarket(CreateMarketParams calldata params) external returns (uint32 marketId, address bank);

    function marketCount() external view returns (uint32);

    function getMarket(uint32 marketId) external view returns (MarketConfig memory config);
}
