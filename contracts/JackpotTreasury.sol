// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";

contract JackpotTreasury is AccessControl, IJackpotTreasury {
    using SafeERC20 for ERC20;

    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");
    address public engine;

    mapping(uint32 => address) public assetByMarket;
    address[] private _jackpotAssets;
    mapping(address => bool) private _isJackpotAsset;

    error OnlyEngine();
    error ZeroAddress();
    error EngineAlreadySet();
    error InvalidWinner();
    error MarketAssetMismatch();

    event EngineSet(address engine);
    event MarketRegistered(uint32 marketId, address assetToken);
    event JackpotFunded(uint256 amount);
    event JackpotPaid(address indexed winner, address[] tokens, uint256[] amounts);

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TREASURY_ADMIN_ROLE, admin);
    }

    function setEngine(address engine_) external onlyRole(TREASURY_ADMIN_ROLE) {
        if (engine_ == address(0)) revert ZeroAddress();
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
        emit EngineSet(engine_);
    }

    function registerMarket(uint32 marketId, address assetToken) external onlyEngine {
        if (assetToken == address(0)) revert ZeroAddress();
        address existingAsset = assetByMarket[marketId];
        if (existingAsset != address(0) && existingAsset != assetToken) {
            revert MarketAssetMismatch();
        }
        assetByMarket[marketId] = assetToken;
        if (!_isJackpotAsset[assetToken]) {
            _isJackpotAsset[assetToken] = true;
            _jackpotAssets.push(assetToken);
        }
        emit MarketRegistered(marketId, assetToken);
    }

    function fundFromEngine(uint256 amount) external onlyEngine {
        if (amount > 0) emit JackpotFunded(amount);
    }


    function jackpotPool() public view override returns (uint256 total) {
        uint256 assetCount = _jackpotAssets.length;
        for (uint256 i; i < assetCount; ) {
            total += ERC20(_jackpotAssets[i]).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }
    }

    function payFullJackpot(address winner) external onlyEngine returns (uint256 paid) {
        if (winner == address(0)) revert InvalidWinner();
        uint256 assetCount = _jackpotAssets.length;
        uint256 payoutTokenCount;
        for (uint256 i; i < assetCount; ) {
            if (ERC20(_jackpotAssets[i]).balanceOf(address(this)) > 0) {
                ++payoutTokenCount;
            }
            unchecked {
                ++i;
            }
        }

        if (payoutTokenCount == 0) return 0;

        address[] memory tokens = new address[](payoutTokenCount);
        uint256[] memory amounts = new uint256[](payoutTokenCount);
        uint256 writeIdx;
        for (uint256 i; i < assetCount; ) {
            address assetToken = _jackpotAssets[i];
            ERC20 token = ERC20(assetToken);
            uint256 assetBalance = token.balanceOf(address(this));
            if (assetBalance > 0) {
                token.safeTransfer(winner, assetBalance);
                paid += assetBalance;
                tokens[writeIdx] = assetToken;
                amounts[writeIdx] = assetBalance;
                unchecked {
                    ++writeIdx;
                }
            }
            unchecked {
                ++i;
            }
        }
        emit JackpotPaid(winner, tokens, amounts);
    }
}
