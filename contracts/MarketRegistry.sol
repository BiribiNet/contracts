// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { BankVault4626 } from "./BankVault4626.sol";

contract MarketRegistry is AccessControl, IMarketRegistry {
    bytes32 public constant MARKET_FACTORY_ROLE = keccak256("MARKET_FACTORY_ROLE");

    mapping(uint32 => MarketConfig) private _markets;
    mapping(address => uint32) private _assetToMarket;
    uint32 private _marketCount;
    address public override vaultBeacon;
    address public immutable override ENGINE;
    address public immutable override SIDE_BET;

    error ZeroAddress();
    error ZeroImplementation();
    error InvalidMarketId();
    error AssetAlreadyRegistered();

    event VaultBeaconUpdated(address previousBeacon, address newBeacon);

    struct VaultInit {
        address asset;
        string bankName;
        string bankSymbol;
        uint32 marketId;
        address engine;
        address bankAdmin;
        uint256 minBet;
        address sideBet;
    }

    constructor(address admin, address engine_, address sideBet_) {
        if (admin == address(0) || engine_ == address(0) || sideBet_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_FACTORY_ROLE, admin);
        ENGINE = engine_;
        SIDE_BET = sideBet_;
    }

    function previewNextMarketId() external view returns (uint32) {
        unchecked {
            return _marketCount + 1;
        }
    }

    function setVaultBeacon(address newBeacon) external onlyRole(MARKET_FACTORY_ROLE) {
        if (newBeacon == address(0)) revert ZeroAddress();
        if (newBeacon.code.length == 0) revert ZeroImplementation();
        // Touch the beacon to ensure it at least implements `implementation()`.
        UpgradeableBeacon(newBeacon).implementation();

        address previous = vaultBeacon;
        vaultBeacon = newBeacon;
        emit VaultBeaconUpdated(previous, newBeacon);
    }

    /// @dev Call `setVaultBeacon` before any `createMarket`.
    /// @dev Vault share `name` is `BRB ` + asset `name()`, share `symbol` is `brb` + asset `symbol()` (via `IERC20Metadata`).
    function createMarket(CreateMarketParams calldata params)
        external
        onlyRole(MARKET_FACTORY_ROLE)
        returns (uint32 marketId, address bank)
    {
        if (params.asset == address(0) || params.bankAdmin == address(0) || params.minBet == 0) revert ZeroAddress();
        if (_assetToMarket[params.asset] != 0) revert AssetAlreadyRegistered();

        IERC20Metadata assetMeta = IERC20Metadata(params.asset);
        string memory bankName = string.concat("BRB ", assetMeta.name());
        string memory bankSymbol = string.concat("brb", assetMeta.symbol());

        uint32 nextId = _marketCount + 1;
        address beacon = vaultBeacon;
        address engine = ENGINE;
        VaultInit memory p;
        p.asset = params.asset;
        p.bankName = bankName;
        p.bankSymbol = bankSymbol;
        p.marketId = nextId;
        p.engine = engine;
        p.bankAdmin = params.bankAdmin;
        p.minBet = params.minBet;
        p.sideBet = SIDE_BET;

        bytes memory initData = _encodeVaultInitData(p);
        bank = _deployVault(beacon, initData);

        marketId = _registerNextMarket(params.asset, bank);
        IRouletteEngine(engine).registerMarketFromRegistry(marketId, bank);
    }

    function _encodeVaultInitData(VaultInit memory p) private pure returns (bytes memory) {
        return abi.encodeWithSelector(
            BankVault4626.initialize.selector,
            BankVault4626.InitializeParams({
                assetToken: p.asset,
                name: p.bankName,
                symbol: p.bankSymbol,
                marketId: p.marketId,
                engine: p.engine,
                admin: p.bankAdmin,
                minBet: p.minBet,
                sideBetController: p.sideBet
            })
        );
    }

    function _deployVault(address beacon, bytes memory initData) private returns (address bank) {
        bank = address(new BeaconProxy(beacon, initData));
    }

    function _registerNextMarket(address asset, address bank) internal returns (uint32 marketId) {
        if (asset == address(0) || bank == address(0)) revert ZeroAddress();

        uint32 next;
        unchecked {
            next = _marketCount + 1;
        }

        _markets[next] = MarketConfig({ asset: asset, bank: bank });
        _assetToMarket[asset] = next;
        _marketCount = next;

        return next;
    }

    function assetToMarket(address asset) external view returns (uint32 marketId) {
        return _assetToMarket[asset];
    }

    function marketCount() external view returns (uint32) {
        return _marketCount;
    }

    function getMarket(uint32 marketId) external view returns (MarketConfig memory config) {
        if (marketId == 0 || marketId > _marketCount) revert InvalidMarketId();
        return _markets[marketId];
    }
}
