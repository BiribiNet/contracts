// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IMarketRegistry } from "../interfaces/IMarketRegistry.sol";

/// @dev Returns a market entry with `bank == address(0)` for SideBet `_marketOrRevert` coverage.
contract MockMarketRegistryZeroBank is IMarketRegistry {
    function marketCount() external pure returns (uint32) {
        return 1;
    }

    function getMarket(uint32) external pure returns (MarketConfig memory config) {
        config.asset = address(0xBEEF);
        config.bank = address(0);
    }

    function vaultBeacon() external pure returns (address) {
        return address(0);
    }

    function ENGINE() external pure returns (address) {
        return address(0);
    }

    function SIDE_BET() external pure returns (address) {
        return address(0);
    }

    function previewNextMarketId() external pure returns (uint32) {
        return 2;
    }

    function setVaultBeacon(address) external pure {}

    function createMarket(CreateMarketParams calldata) external pure returns (uint32 marketId, address bank) {
        return (0, address(0));
    }

    function assetToMarket(address) external pure returns (uint32 marketId) {
        return 0;
    }
}
