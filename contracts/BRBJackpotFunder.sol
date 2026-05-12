// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IUniswapV2Router02 } from "./interfaces/IUniswapV2Router02.sol";

/// @notice Swaps a slice of per-round market profit (in market asset) to BRB via Uniswap V2; splits BRB between jackpot treasury and burn.
contract BRBJackpotFunder is AccessControl, IBRBJackpotFunder {
    using SafeERC20 for IERC20;

    bytes32 public constant FUNDER_ADMIN_ROLE = keccak256("FUNDER_ADMIN_ROLE");

    address public engine;
    IERC20 public immutable brb;
    IUniswapV2Router02 public immutable router;
    address public immutable jackpotTreasury;

    /// @notice BPS of `marketWin` used as swap input (e.g. 300 = 3%).
    uint256 public override swapAssetTotalBps;

    /// @notice After swap, BRB sent to treasury = `brbOut * treasuryBrbNumerator / treasuryBrbDenominator` (e.g. 250/300).
    uint256 public treasuryBrbNumerator;
    uint256 public treasuryBrbDenominator;

    /// @notice Slippage guard on min BRB out: minOut *= (10_000 - slippageBps) / 10_000.
    uint256 public slippageBps;

    /// @notice Expected BRB wei per 1 asset wei (1e18 scale) for min-out sanity bound per market.
    mapping(uint32 => uint256) public brbPerAssetUnitRatio;

    uint256 public constant RATIO_SCALE = 1e18;
    uint256 public constant BPS_DENOM = 10_000;

    error ZeroAddress();
    error OnlyEngine();
    error EngineAlreadySet();
    error InvalidBps();
    error RatioNotSet();
    error AssetBrbMismatch();

    event SwapAssetBpsUpdated(uint256 totalBps);
    event TreasuryBrbSplitUpdated(uint256 numerator, uint256 denominator);
    event SlippageBpsUpdated(uint256 slippageBps);
    event BrbRatioUpdated(uint32 marketId, uint256 ratioPerAssetUnit);
    event FundedFromMarket(
        uint32 indexed marketId,
        address indexed asset,
        uint256 marketWin,
        uint256 assetSwapped,
        uint256 brbOut,
        uint256 brbToTreasury,
        uint256 brbBurned
    );

    constructor(
        address engine_,
        address brb_,
        address router_,
        address jackpotTreasury_,
        address admin
    ) {
        if (brb_ == address(0) || router_ == address(0) || jackpotTreasury_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        engine = engine_;
        brb = IERC20(brb_);
        router = IUniswapV2Router02(router_);
        jackpotTreasury = jackpotTreasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FUNDER_ADMIN_ROLE, admin);

        swapAssetTotalBps = 300;
        treasuryBrbNumerator = 250;
        treasuryBrbDenominator = 300;
        slippageBps = 100;
    }

    function setEngine(address engine_) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (engine_ == address(0)) revert ZeroAddress();
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    function setSwapAssetBps(uint256 totalBps) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (totalBps > 1_000) revert InvalidBps();
        swapAssetTotalBps = totalBps;
        emit SwapAssetBpsUpdated(totalBps);
    }

    function setTreasuryBrbSplit(uint256 numerator, uint256 denominator) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (denominator == 0 || numerator > denominator) revert InvalidBps();
        treasuryBrbNumerator = numerator;
        treasuryBrbDenominator = denominator;
        emit TreasuryBrbSplitUpdated(numerator, denominator);
    }

    function setSlippageBps(uint256 bps) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (bps >= BPS_DENOM) revert InvalidBps();
        slippageBps = bps;
        emit SlippageBpsUpdated(bps);
    }

    function setBrbPerAssetUnitRatio(uint32 marketId, uint256 ratio) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (ratio == 0) revert RatioNotSet();
        brbPerAssetUnitRatio[marketId] = ratio;
        emit BrbRatioUpdated(marketId, ratio);
    }

    /// @inheritdoc IBRBJackpotFunder
    function fundFromMarket(uint32 marketId, address asset, uint256 marketWin) external override onlyEngine {
        if (marketWin == 0) return;
        uint256 ratio = brbPerAssetUnitRatio[marketId];
        if (ratio == 0) revert RatioNotSet();

        uint256 swapIn = (marketWin * swapAssetTotalBps) / BPS_DENOM;
        if (swapIn == 0) return;

        IERC20 assetToken = IERC20(asset);
        uint256 bal = assetToken.balanceOf(address(this));
        if (bal < swapIn) revert AssetBrbMismatch();

        uint256 minBrbOut = (swapIn * ratio) / RATIO_SCALE;
        minBrbOut = (minBrbOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;

        address[] memory path = new address[](2);
        path[0] = asset;
        path[1] = address(brb);

        assetToken.forceApprove(address(router), swapIn);

        uint256 brbBefore = brb.balanceOf(address(this));
        router.swapExactTokensForTokens(swapIn, minBrbOut, path, address(this), block.timestamp + 600);
        uint256 brbOut = brb.balanceOf(address(this)) - brbBefore;
        assetToken.forceApprove(address(router), 0);

        uint256 toTreasury = (brbOut * treasuryBrbNumerator) / treasuryBrbDenominator;
        uint256 toBurn = brbOut - toTreasury;

        if (toTreasury > 0) {
            brb.safeTransfer(jackpotTreasury, toTreasury);
        }
        if (toBurn > 0) {
            brb.safeTransfer(address(0x000000000000000000000000000000000000dEaD), toBurn);
        }

        emit FundedFromMarket(marketId, asset, marketWin, swapIn, brbOut, toTreasury, toBurn);
    }
}
