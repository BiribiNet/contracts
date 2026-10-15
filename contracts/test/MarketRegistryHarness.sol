// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MarketRegistry } from "../MarketRegistry.sol";

/// @dev Exposes internal `_registerNextMarket` for branch coverage tests only.
contract MarketRegistryHarness is MarketRegistry {
    constructor(address admin, address engine, address sideBet) MarketRegistry(admin, engine, sideBet) {}

    function testRegisterNextMarket(address asset, address bank) external returns (uint32 marketId) {
        return _registerNextMarket(asset, bank);
    }
}
