// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IUniswapV2Router02 } from "./interfaces/IUniswapV2Router02.sol";

/// @dev BRB must implement burn-on-holder balance (e.g. OpenZeppelin `ERC20Burnable`).
interface IERC20BurnFromSelf {
    function burn(uint256 value) external;
}

/// @notice Swaps the contract's current `asset` balance to BRB via Uniswap V2 (when `asset != brb`); splits BRB between jackpot treasury and on-chain burn (reduces total supply).
/// @dev `fundFromMarket` does not revert on swap failure, treasury transfer failure, or burn failure (emits / try-catch) so settlement is not bricked by Uniswap or BRB hooks. Swap size is `IERC20(asset).balanceOf(address(this))` after the engine's `transferOut`; the engine uses `swapAssetTotalBps` and per-round profit on its side to decide how much to send.
///
/// Audit fixes (Critical + High) vs initial `markets`-branch implementation:
/// - C-1: on-chain quote (`getAmountsOut`) and `slippageBps` are now wired into `amountOutMin`. An emergency `bypassSlippageCheck` flag preserves the legacy 0-min behaviour for stuck-queue recovery.
/// - H-5: `engine` is required non-zero at deploy time and stored `immutable`; the one-shot `setEngine` pattern is removed.
contract BRBJackpotFunder is AccessControl, IBRBJackpotFunder {
    using SafeERC20 for IERC20;

    bytes32 public constant FUNDER_ADMIN_ROLE = keccak256("FUNDER_ADMIN_ROLE");

    /// @dev Skip reason: router `swapExactTokensForTokens` reverted (liquidity, path, deadline, etc.).
    uint8 public constant SKIP_SWAP_REVERTED = 2;
    /// @dev Skip reason: `getAmountsOut` quote reverted; cannot price `amountOutMin` safely.
    uint8 public constant SKIP_PRICE_QUOTE = 3;

    address public immutable engine;
    IERC20 public immutable brb;
    IUniswapV2Router02 public immutable router;
    address public immutable jackpotTreasury;

    /// @notice BPS the engine uses against per-round profit to size `transferOut` before `fundFromMarket` (e.g. 300 = 3%). Not read here to size the swap input.
    uint256 public override swapAssetTotalBps;

    /// @notice After swap, BRB sent to treasury = `brbOut * treasuryBrbNumerator / treasuryBrbDenominator` (e.g. 250/300).
    uint256 public treasuryBrbNumerator;
    uint256 public treasuryBrbDenominator;

    /// @notice Slippage tolerance applied to the on-chain quote when computing `amountOutMin`. Default 100 bps = 1%.
    uint256 public slippageBps;

    /// @notice Emergency-only override that restores legacy `amountOutMin = 0` behaviour for clearing a stuck queue.
    bool public bypassSlippageCheck;

    /// @notice Optional metadata / off-chain jackpot parity (decimals across assets); not read in `fundFromMarket`.
    mapping(uint32 => uint256) public brbPerAssetUnitRatio;

    uint256 public constant RATIO_SCALE = 1e18;
    uint256 public constant BPS_DENOM = 10_000;

    error ZeroAddress();
    error OnlyEngine();
    error InvalidBps();
    error RatioNotSet();

    event SwapAssetBpsUpdated(uint256 totalBps);
    event TreasuryBrbSplitUpdated(uint256 numerator, uint256 denominator);
    event SlippageBpsUpdated(uint256 slippageBps);
    event BypassSlippageUpdated(bool bypass);
    event BrbRatioUpdated(uint32 marketId, uint256 ratioPerAssetUnit);
    event FundFromMarketSkipped(uint32 indexed marketId, address indexed asset, uint8 reason);
    event JackpotTreasuryTransferFailed(uint32 indexed marketId, address indexed treasury, uint256 amount);
    event JackpotBurnFailed(uint32 indexed marketId, uint256 amount);
    event FundedFromMarket(
        uint32 marketId,
        address asset,
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
        if (
            engine_ == address(0)
                || brb_ == address(0)
                || router_ == address(0)
                || jackpotTreasury_ == address(0)
                || admin == address(0)
        ) {
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

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    /// @inheritdoc IBRBJackpotFunder
    function brbToken() external view returns (address) {
        return address(brb);
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

    function setBypassSlippageCheck(bool bypass) external onlyRole(FUNDER_ADMIN_ROLE) {
        bypassSlippageCheck = bypass;
        emit BypassSlippageUpdated(bypass);
    }

    function setBrbPerAssetUnitRatio(uint32 marketId, uint256 ratio) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (ratio == 0) revert RatioNotSet();
        brbPerAssetUnitRatio[marketId] = ratio;
        emit BrbRatioUpdated(marketId, ratio);
    }

    /// @inheritdoc IBRBJackpotFunder
    function fundFromMarket(uint32 marketId, address asset) external override onlyEngine {
        IERC20 assetToken = IERC20(asset);
        uint256 swapIn = assetToken.balanceOf(address(this));
        if (swapIn == 0) return;

        uint256 brbOut;
        if (asset == address(brb)) {
            brbOut = swapIn;
        } else {
            address[] memory path = new address[](2);
            path[0] = asset;
            path[1] = address(brb);

            uint256 amountOutMin;
            if (bypassSlippageCheck) {
                amountOutMin = 0;
            } else {
                try router.getAmountsOut(swapIn, path) returns (uint256[] memory amounts) {
                    uint256 expectedOut = amounts[amounts.length - 1];
                    amountOutMin = (expectedOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;
                } catch {
                    emit FundFromMarketSkipped(marketId, asset, SKIP_PRICE_QUOTE);
                    return;
                }
            }

            assetToken.forceApprove(address(router), swapIn);

            uint256 brbBefore = brb.balanceOf(address(this));
            try router.swapExactTokensForTokens(
                swapIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp + 600
            ) returns (uint256[] memory) {
                brbOut = brb.balanceOf(address(this)) - brbBefore;
            } catch {
                emit FundFromMarketSkipped(marketId, asset, SKIP_SWAP_REVERTED);
                brbOut = 0;
            }

            assetToken.forceApprove(address(router), 0);
        }

        if (brbOut == 0) return;

        uint256 toTreasury = (brbOut * treasuryBrbNumerator) / treasuryBrbDenominator;
        uint256 toBurn = brbOut - toTreasury;

        uint256 sentTreasury;
        if (toTreasury > 0) {
            try brb.transfer(jackpotTreasury, toTreasury) returns (bool ok) {
                if (ok) {
                    sentTreasury = toTreasury;
                } else {
                    emit JackpotTreasuryTransferFailed(marketId, jackpotTreasury, toTreasury);
                }
            } catch {
                emit JackpotTreasuryTransferFailed(marketId, jackpotTreasury, toTreasury);
            }
        }

        uint256 burnedAmt;
        if (toBurn > 0) {
            try IERC20BurnFromSelf(address(brb)).burn(toBurn) {
                burnedAmt = toBurn;
            } catch {
                emit JackpotBurnFailed(marketId, toBurn);
            }
        }

        emit FundedFromMarket(marketId, asset, swapIn, brbOut, sentTreasury, burnedAmt);
    }
}
