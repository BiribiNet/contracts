// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IUniswapV2Router02 } from "./interfaces/IUniswapV2Router02.sol";
import { IUniswapV2Factory } from "./vendor/uniswap-v2-core/interfaces/IUniswapV2Factory.sol";
import { UniswapV2TwapLib } from "./libraries/UniswapV2TwapLib.sol";

/// @dev BRB must implement burn-on-holder balance (e.g. OpenZeppelin `ERC20Burnable`).
interface IERC20BurnFromSelf {
    function burn(uint256 value) external;
}

/// @notice Swaps the contract's current `asset` balance to BRB via Uniswap V2 (when `asset != brb`); splits BRB between jackpot treasury and on-chain burn (reduces total supply).
/// @dev `fundFromMarket` does not revert on swap failure, treasury transfer failure, or burn failure (emits / try-catch) so settlement is not bricked by Uniswap or BRB hooks. Swap size is `IERC20(asset).balanceOf(address(this))` after the engine's `transferOut`; the engine uses `swapAssetTotalBps` and per-round profit on its side to decide how much to send. Non-BRB swaps use a Uniswap V2 TWAP floor when the observation window is warm (`slippageBps`); otherwise spot with `coldSlippageBps` (stricter, default 3%).
contract BRBJackpotFunder is AccessControl, IBRBJackpotFunder {
    using SafeERC20 for IERC20;

    bytes32 public constant FUNDER_ADMIN_ROLE = keccak256("FUNDER_ADMIN_ROLE");

    /// @dev Skip reason: router `swapExactTokensForTokens` reverted (liquidity, path, TWAP min, deadline, etc.).
    uint8 public constant SKIP_SWAP_REVERTED = 2;
    /// @dev Skip reason: could not derive a positive `amountOutMin` (no pair / no liquidity / zero quote).
    uint8 public constant SKIP_NO_QUOTE = 3;

    address public immutable engine;
    address public immutable sideBet;
    IERC20 public immutable brb;
    IUniswapV2Router02 public immutable router;
    address public immutable jackpotTreasury;

    /// @notice BPS the engine uses against per-round profit to size `transferOut` before `fundFromMarket` (e.g. 300 = 3%). Not read here to size the swap input.
    uint256 public override swapAssetTotalBps;

    /// @notice After swap, BRB sent to treasury = `brbOut * treasuryBrbNumerator / treasuryBrbDenominator` (e.g. 250/300).
    uint256 public treasuryBrbNumerator;
    uint256 public treasuryBrbDenominator;

    /// @notice Max deviation below TWAP quote for `amountOutMin` when the pair observation window is warm (e.g. 100 = 1%).
    uint256 public slippageBps;

    /// @notice Max deviation below spot / router quote when TWAP is cold (no observation yet or window not elapsed; e.g. 300 = 3%).
    uint256 public coldSlippageBps;

    /// @notice Minimum elapsed time since the last stored pair observation before TWAP is used (default 30 minutes).
    uint32 public twapWindowSeconds;

    /// @dev Anchor observation per Uniswap V2 pair (asset/BRB): the start of the TWAP window. Once
    /// seeded it is always at least `twapWindowSeconds` old, so the TWAP branch is actually reachable.
    /// It is NOT overwritten by every swap — that kept the window permanently cold under normal round
    /// cadence, leaving `amountOutMin` derived from spot alone.
    mapping(address pair => UniswapV2TwapLib.Observation) public pairObservations;

    /// @dev Most recent sample per pair (still taken after every successful swap). Promoted to the
    /// anchor once it has aged past `twapWindowSeconds`.
    mapping(address pair => UniswapV2TwapLib.Observation) public pendingPairObservations;

    uint256 public constant BPS_DENOM = 10_000;
    uint32 public constant DEFAULT_TWAP_WINDOW_SECONDS = 30 minutes;

    error ZeroAddress();
    error OnlyFeeCollector();
    error InvalidBps();
    error ZeroAmount();
    error InsufficientBalance();

    event SwapAssetBpsUpdated(uint256 totalBps);
    event TreasuryBrbSplitUpdated(uint256 numerator, uint256 denominator);
    event SlippageBpsUpdated(uint256 slippageBps);
    event ColdSlippageBpsUpdated(uint256 coldSlippageBps);
    event TwapWindowUpdated(uint32 twapWindowSeconds);
    event PairObservationUpdated(address pair, uint32 timestamp);
    event FundFromMarketSkipped(uint32 marketId, address asset, uint8 reason);
    event JackpotTreasuryTransferFailed(uint32 marketId, address treasury, uint256 amount);
    event JackpotBurnFailed(uint32 marketId, uint256 amount);
    event TokenSwept(address asset, address to, uint256 amount);
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
        address sideBet_,
        address admin
    ) {
        if (
            engine_ == address(0) || brb_ == address(0) || router_ == address(0) || jackpotTreasury_ == address(0)
                || admin == address(0)
        ) {
            revert ZeroAddress();
        }
        engine = engine_;
        sideBet = sideBet_;
        brb = IERC20(brb_);
        router = IUniswapV2Router02(router_);
        jackpotTreasury = jackpotTreasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FUNDER_ADMIN_ROLE, admin);

        swapAssetTotalBps = 300;
        treasuryBrbNumerator = 250;
        treasuryBrbDenominator = 300;
        slippageBps = 100;
        coldSlippageBps = 300;
        twapWindowSeconds = DEFAULT_TWAP_WINDOW_SECONDS;
    }

    modifier onlyFeeCollector() {
        if (msg.sender != engine && msg.sender != sideBet) revert OnlyFeeCollector();
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

    function setColdSlippageBps(uint256 bps) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (bps >= BPS_DENOM) revert InvalidBps();
        coldSlippageBps = bps;
        emit ColdSlippageBpsUpdated(bps);
    }

    function setTwapWindowSeconds(uint32 newWindow) external onlyRole(FUNDER_ADMIN_ROLE) {
        twapWindowSeconds = newWindow;
        emit TwapWindowUpdated(newWindow);
    }

    /// @notice Recover market assets left after skipped swaps (TWAP / liquidity). Use when migrating to a new funder or during prolonged pool stress.
    /// @param amount `0` sweeps the full balance of `asset`.
    function sweepToken(address asset, address to, uint256 amount) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 xfer = amount == 0 ? balance : amount;
        if (xfer == 0) revert ZeroAmount();
        if (xfer > balance) revert InsufficientBalance();
        IERC20(asset).safeTransfer(to, xfer);
        emit TokenSwept(asset, to, xfer);
    }

    /// @inheritdoc IBRBJackpotFunder
    function fundFromMarket(uint32 marketId, address asset) external override onlyFeeCollector {
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

            uint256 amountOutMin = _amountOutMin(asset, swapIn, path);
            if (amountOutMin == 0) {
                emit FundFromMarketSkipped(marketId, asset, SKIP_NO_QUOTE);
                return;
            }

            assetToken.forceApprove(address(router), swapIn);

            uint256 brbBefore = brb.balanceOf(address(this));
            try router.swapExactTokensForTokens(swapIn, amountOutMin, path, address(this), block.timestamp + 600) returns (
                uint256[] memory
            ) {
                brbOut = brb.balanceOf(address(this)) - brbBefore;
            } catch {
                emit FundFromMarketSkipped(marketId, asset, SKIP_SWAP_REVERTED);
            }

            assetToken.forceApprove(address(router), 0);

            if (brbOut > 0) {
                _snapshotPairObservation(asset);
            }
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

    /// @dev TWAP quote when `pairObservations` is older than `twapWindowSeconds`; otherwise spot. Applies warm or cold slippage on top.
    function _amountOutMin(address asset, uint256 swapIn, address[] memory path) internal view returns (uint256 amountOutMin) {
        address pair = _assetBrbPair(asset);
        if (pair == address(0)) {
            return _routerSpotMinOut(swapIn, path, coldSlippageBps);
        }

        uint256 quotedOut;
        bool usedTwap;
        (quotedOut, usedTwap) = _quoteOut(pair, asset, swapIn);
        if (quotedOut == 0) return 0;

        uint256 slip = usedTwap ? slippageBps : coldSlippageBps;
        unchecked {
            amountOutMin = quotedOut * (BPS_DENOM - slip) / BPS_DENOM;
        }
    }

    function _quoteOut(address pair, address asset, uint256 swapIn)
        internal
        view
        returns (uint256 quotedOut, bool usedTwap)
    {
        uint256 spotOut = UniswapV2TwapLib.spotAmountOut(pair, asset, swapIn);
        if (spotOut == 0) return (0, false);

        UniswapV2TwapLib.Observation memory obs = pairObservations[pair];
        uint32 nowTs = uint32(block.timestamp);
        uint32 window = twapWindowSeconds;

        if (window > 0 && obs.timestamp != 0 && nowTs > obs.timestamp && nowTs - obs.timestamp >= window) {
            uint256 twapOut = UniswapV2TwapLib.quoteTwapAmountOut(pair, asset, swapIn, obs, nowTs);
            // Protective floor: only a TWAP ABOVE spot carries information — it means spot has been
            // pushed down (sandwich, thin liquidity), which is exactly when the floor must bite.
            // Taking the lower of the two, as this did before, made `amountOutMin` follow the
            // manipulated spot and removed the protection in the one case it exists for.
            // A TWAP at or below spot adds nothing, so keep spot under its stricter cold slippage.
            if (twapOut > spotOut) {
                return (twapOut, true);
            }
        }

        return (spotOut, false);
    }

    function _routerSpotMinOut(uint256 swapIn, address[] memory path, uint256 slipBps)
        internal
        view
        returns (uint256 amountOutMin)
    {
        try router.getAmountsOut(swapIn, path) returns (uint256[] memory amounts) {
            if (amounts.length < 2 || amounts[1] == 0) return 0;
            unchecked {
                amountOutMin = amounts[1] * (BPS_DENOM - slipBps) / BPS_DENOM;
            }
        } catch {
            return 0;
        }
    }

    function _assetBrbPair(address asset) internal view returns (address pair) {
        address factory = router.factory();
        if (factory == address(0)) return address(0);
        return IUniswapV2Factory(factory).getPair(asset, address(brb));
    }

    function _snapshotPairObservation(address asset) internal {
        address pair = _assetBrbPair(asset);
        if (pair == address(0)) return;

        (uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp) =
            UniswapV2TwapLib.currentCumulativePrices(pair);
        UniswapV2TwapLib.Observation memory sample = UniswapV2TwapLib.Observation({
            timestamp: timestamp,
            price0Cumulative: price0Cumulative,
            price1Cumulative: price1Cumulative
        });

        UniswapV2TwapLib.Observation memory pending = pendingPairObservations[pair];
        if (pending.timestamp == 0) {
            // First sample for this pair: seed both slots and let the anchor start ageing.
            pairObservations[pair] = sample;
            pendingPairObservations[pair] = sample;
            emit PairObservationUpdated(pair, timestamp);
            return;
        }

        pendingPairObservations[pair] = sample;

        // Roll the anchor forward only once the previous sample has aged past the window, so the
        // anchor keeps a >= `twapWindowSeconds` lookback instead of being reset by every swap.
        uint32 window = twapWindowSeconds;
        if (window > 0 && timestamp > pending.timestamp && timestamp - pending.timestamp >= window) {
            pairObservations[pair] = pending;
            emit PairObservationUpdated(pair, pending.timestamp);
        }
    }
}
