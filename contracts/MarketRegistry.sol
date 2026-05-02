// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";

contract MarketRegistry is AccessControl, IMarketRegistry {
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");

    mapping(uint32 => MarketConfig) private _markets;
    uint32 private _marketCount;

    error ZeroAddress();
    error InvalidRoundDuration();
    error InvalidMaxBetsPerRound();
    error InvalidMarketId();
    error MarketAlreadyRegistered();

    event MarketRegistered(uint32 marketId, address asset, address bank, uint32 roundDuration);
    event MarketEnabledUpdated(uint32 marketId, bool enabled);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_ADMIN_ROLE, admin);
    }

    function registerMarket(
        address asset,
        address bank,
        uint32 roundDuration,
        uint32 maxBetsPerRound
    ) external onlyRole(MARKET_ADMIN_ROLE) returns (uint32 marketId) {
        if (asset == address(0) || bank == address(0)) revert ZeroAddress();
        if (roundDuration == 0) revert InvalidRoundDuration();
        if (maxBetsPerRound == 0) revert InvalidMaxBetsPerRound();

        uint32 next = _marketCount + 1;
        if (_markets[next].bank != address(0)) revert MarketAlreadyRegistered();

        _markets[next] = MarketConfig({
            asset: asset,
            bank: bank,
            roundDuration: roundDuration,
            maxBetsPerRound: maxBetsPerRound,
            enabled: true
        });
        _marketCount = next;

        emit MarketRegistered(next, asset, bank, roundDuration);
        return next;
    }

    function setMarketEnabled(uint32 marketId, bool enabled) external onlyRole(MARKET_ADMIN_ROLE) {
        if (marketId == 0 || marketId > _marketCount) revert InvalidMarketId();
        _markets[marketId].enabled = enabled;
        emit MarketEnabledUpdated(marketId, enabled);
    }

    function marketCount() external view returns (uint32) {
        return _marketCount;
    }

    function getMarket(uint32 marketId) external view returns (MarketConfig memory config) {
        if (marketId == 0 || marketId > _marketCount) revert InvalidMarketId();
        return _markets[marketId];
    }
}
