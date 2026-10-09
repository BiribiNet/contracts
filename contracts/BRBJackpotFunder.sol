// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IUniswapV2Pair } from "./vendor/uniswap-v2-core/interfaces/IUniswapV2Pair.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IUniswapV2Router02 } from "./interfaces/IUniswapV2Router02.sol";
import { IUniswapV2Factory } from "./vendor/uniswap-v2-core/interfaces/IUniswapV2Factory.sol";
import { UniswapV2TwapLib } from "./libraries/UniswapV2TwapLib.sol";

/// @dev BRB must implement burn-on-holder balance (e.g. OpenZeppelin `ERC20Burnable`).
interface IERC20BurnFromSelf {
    function burn(uint256 value) external;
}

/// @notice Exact per-vault funding queues, permissionless bounded execution and BRB distribution.
/// @dev New collectors enqueue after transfer; external token/router calls run in a separate worker.
contract BRBJackpotFunder is AccessControl, ReentrancyGuard, IBRBJackpotFunder {
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

    /// @dev Oldest pending sample per pair, retained between successful swaps. Promoted to the
    /// anchor once it has aged past `twapWindowSeconds`.
    mapping(address pair => UniswapV2TwapLib.Observation) public pendingPairObservations;

    uint256 public constant BPS_DENOM = 10_000;
    uint32 public constant DEFAULT_TWAP_WINDOW_SECONDS = 30 minutes;

    error ZeroAddress();
    error OnlyFeeCollector();
    error InvalidBps();
    error ZeroAmount();
    error InsufficientBalance();
    error AssetMismatch();
    error OnlySelf();
    error BatchTooLarge();
    error InsufficientAttemptGas();

    struct FundingAccount {
        address asset;
        uint256 queued;
        uint256 credited;
        uint256 processed;
        uint256 brbProduced;
        uint256 treasuryPaid;
        uint256 burned;
    }
    mapping(uint32 => FundingAccount) public fundingAccounts;
    mapping(address => uint256) public queuedAssetTotals;
    mapping(uint32 => uint8) public consecutiveFailures;
    mapping(uint32 => uint256) public nextAttemptAt;
    uint256 public constant RETRY_DELAY = 60;
    uint8 public constant MAX_FAILURES = 5;
    uint256 public constant ATTEMPT_GAS = 500_000;
    uint256 public maxSwapReserveBps = 100; // At most 1% of the current input reserve.
    event FundingQueued(uint32 indexed marketId, address indexed asset, uint256 amount, uint256 pending);
    event FundingRetryScheduled(uint32 indexed marketId, uint8 failures, uint256 nextAttemptAt, bool stopped);
    event FundingRetryReset(uint32 indexed marketId);
    event FundingImported(uint32 indexed marketId, address indexed asset, uint256 amount, bytes32 sourceTransaction);
    event MaxSwapReserveBpsUpdated(uint256 bps);
    event FundingReconciled(uint32 indexed marketId, address indexed asset, uint256 credited, uint256 processed,
        uint256 queued, uint256 brbProduced, uint256 treasuryPaid, uint256 burned,
        uint256 pendingTreasury, uint256 pendingBurn);

    /// @notice Pure bookkeeping after the collector transfers the exact fee. No router/token calls.
    /// @dev Collectors must transfer standard, non-rebasing, non-fee-on-transfer assets atomically.
    function queueFunding(uint32 marketId, address asset, uint256 amount) external override onlyFeeCollector {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _credit(marketId, asset, amount);
    }

    /// @notice Explicitly assign already transferred migration inputs, with their source receipt.
    /// @dev Old BRB distribution liabilities must be repaid on the old funder, not imported as input.
    function importFunding(uint32 marketId, address asset, uint256 amount, bytes32 sourceTransaction)
        external onlyRole(FUNDER_ADMIN_ROLE) nonReentrant
    {
        if (asset == address(0) || sourceTransaction == bytes32(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 free = IERC20(asset).balanceOf(address(this)) - queuedAssetTotals[asset];
        if (asset == address(brb)) free -= pendingTreasuryBrb + pendingBurnBrb;
        if (amount > free) revert InsufficientBalance();
        emit FundingImported(marketId, asset, amount, sourceTransaction);
        _credit(marketId, asset, amount);
    }

    function _credit(uint32 marketId, address asset, uint256 amount) private {
        FundingAccount storage a = fundingAccounts[marketId];
        if (a.asset == address(0)) a.asset = asset;
        if (a.asset != asset) revert AssetMismatch();
        a.queued += amount;
        a.credited += amount;
        queuedAssetTotals[asset] += amount;
        emit FundingQueued(marketId, asset, amount, a.queued);
        _reconcile(marketId);
    }

    function _reconcile(uint32 marketId) private {
        FundingAccount storage a = fundingAccounts[marketId];
        emit FundingReconciled(marketId, a.asset, a.credited, a.processed, a.queued,
            a.brbProduced, a.treasuryPaid, a.burned,
            pendingBrbByMarket[marketId].treasury, pendingBrbByMarket[marketId].burn);
    }

    function setMaxSwapReserveBps(uint256 bps) external onlyRole(FUNDER_ADMIN_ROLE) {
        if (bps == 0 || bps > 500) revert InvalidBps();
        maxSwapReserveBps = bps;
        emit MaxSwapReserveBpsUpdated(bps);
    }

    /// @notice Permissionless oracle maintenance, independent of swap success.
    function updateObservation(address asset) external nonReentrant {
        _snapshotPairObservation(asset);
    }

    function resetFundingRetry(uint32 marketId) external onlyRole(FUNDER_ADMIN_ROLE) {
        consecutiveFailures[marketId] = 0;
        nextAttemptAt[marketId] = 0;
        emit FundingRetryReset(marketId);
    }

    /// @notice One gas-bounded attempt; failures never erase the queue.
    function processFunding(uint32 marketId) external nonReentrant returns (bool) {
        return _processFunding(marketId);
    }

    function processFundingBatch(uint32[] calldata marketIds) external nonReentrant {
        if (marketIds.length > 10) revert BatchTooLarge();
        for (uint256 i; i < marketIds.length; ++i) _processFunding(marketIds[i]);
    }

    function _processFunding(uint32 marketId) private returns (bool complete) {
        FundingAccount storage a = fundingAccounts[marketId];
        if (a.asset == address(0) || (a.queued == 0 && pendingBrbByMarket[marketId].treasury == 0
            && pendingBrbByMarket[marketId].burn == 0)) return true;
        if (consecutiveFailures[marketId] >= MAX_FAILURES || block.timestamp < nextAttemptAt[marketId]) return false;
        // A permissionless caller cannot exhaust the retry budget with an underfunded gas limit.
        if (gasleft() < ATTEMPT_GAS + 200_000) revert InsufficientAttemptGas();
        uint256 attemptId = ++fundingAttemptCount;
        // Ledger balances avoid token getter failures outside the isolated call.
        emit FundingAttemptStarted(attemptId, marketId, a.asset, a.queued,
            pendingBrbByMarket[marketId].treasury + pendingBrbByMarket[marketId].burn);
        bool progressed;
        try this.executeFunding{gas: ATTEMPT_GAS}(marketId) returns (bool progress) { progressed = progress; }
        catch { emit FundFromMarketSkipped(marketId, a.asset, SKIP_SWAP_REVERTED); }
        if (progressed && pendingBrbByMarket[marketId].treasury == 0 && pendingBrbByMarket[marketId].burn == 0) {
            consecutiveFailures[marketId] = 0;
        } else {
            ++consecutiveFailures[marketId];
        }
        nextAttemptAt[marketId] = block.timestamp + RETRY_DELAY;
        emit FundingRetryScheduled(marketId, consecutiveFailures[marketId], nextAttemptAt[marketId],
            consecutiveFailures[marketId] >= MAX_FAILURES);
        emit FundingAttemptCompleted(attemptId, a.queued,
            pendingBrbByMarket[marketId].treasury + pendingBrbByMarket[marketId].burn);
        _reconcile(marketId);
        return a.queued == 0 && pendingBrbByMarket[marketId].treasury == 0 && pendingBrbByMarket[marketId].burn == 0;
    }

    /// @dev Self-call boundary rolls back approvals, token transfers and ledger changes together.
    function executeFunding(uint32 marketId) external returns (bool progressed) {
        if (msg.sender != address(this)) revert OnlySelf();
        FundingAccount storage a = fundingAccounts[marketId];
        uint256 beforeQueued = a.queued;
        uint256 beforePending = pendingBrbByMarket[marketId].treasury + pendingBrbByMarket[marketId].burn;
        _retryPendingBrb(marketId);
        _fundFromMarket(marketId, a.asset, true);
        return a.queued < beforeQueued || pendingBrbByMarket[marketId].treasury + pendingBrbByMarket[marketId].burn < beforePending;
    }

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
    function sweepToken(address asset, address to, uint256 amount) external onlyRole(FUNDER_ADMIN_ROLE) nonReentrant {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        balance -= queuedAssetTotals[asset];
        if (asset == address(brb)) balance -= pendingTreasuryBrb + pendingBurnBrb;
        uint256 xfer = amount == 0 ? balance : amount;
        if (xfer == 0) revert ZeroAmount();
        if (xfer > balance) revert InsufficientBalance();
        IERC20(asset).safeTransfer(to, xfer);
        emit TokenSwept(asset, to, xfer);
    }

    struct PendingBrb { uint256 treasury; uint256 burn; }
    mapping(uint32 => PendingBrb) public pendingBrbByMarket;
    uint256 public pendingTreasuryBrb;
    uint256 public pendingBurnBrb;
    event PendingBrbDistributed(uint32 indexed marketId, uint256 treasuryAmount, uint256 burnedAmount);

    function retryPendingBrb(uint32 marketId) external onlyRole(FUNDER_ADMIN_ROLE) nonReentrant {
        _retryPendingBrb(marketId);
        _reconcile(marketId);
    }

    function _retryPendingBrb(uint32 marketId) private {
        PendingBrb memory owed = pendingBrbByMarket[marketId];
        if (owed.treasury == 0 && owed.burn == 0) return;
        delete pendingBrbByMarket[marketId];
        pendingTreasuryBrb -= owed.treasury;
        pendingBurnBrb -= owed.burn;
        (uint256 sent, uint256 burned) = _distributeBrb(marketId, owed.treasury, owed.burn);
        emit PendingBrbDistributed(marketId, sent, burned);
    }

    uint256 public fundingAttemptCount;
    event FundingAttemptStarted(uint256 indexed attemptId, uint32 indexed marketId, address indexed asset, uint256 inputBalance, uint256 brbBalance);
    event FundingAttemptCompleted(uint256 indexed attemptId, uint256 remainingInput, uint256 remainingBrb);

    /// @notice Raw balances retained here, not an attribution to a single round.
    function pendingFundingBalances(address asset) external view returns (uint256 inputBalance, uint256 brbBalance) {
        return (IERC20(asset).balanceOf(address(this)), brb.balanceOf(address(this)));
    }

    function fundFromMarket(uint32 marketId, address asset) external override onlyFeeCollector nonReentrant {
        address boundAsset = fundingAccounts[marketId].asset;
        if (boundAsset != address(0) && boundAsset != asset) revert AssetMismatch();
        // Legacy collectors may credit only previously unassigned balance, never another vault's queue.
        uint256 free = IERC20(asset).balanceOf(address(this)) - queuedAssetTotals[asset];
        if (asset == address(brb)) free -= pendingTreasuryBrb + pendingBurnBrb;
        if (free > 0) _credit(marketId, asset, free);
        uint256 attemptId = ++fundingAttemptCount;
        emit FundingAttemptStarted(attemptId, marketId, asset, IERC20(asset).balanceOf(address(this)), brb.balanceOf(address(this)));
        _retryPendingBrb(marketId);
        _fundFromMarket(marketId, asset, false);
        _reconcile(marketId);
        emit FundingAttemptCompleted(attemptId, IERC20(asset).balanceOf(address(this)), brb.balanceOf(address(this)));
    }

    function _fundFromMarket(uint32 marketId, address asset, bool bounded) private {
        IERC20 assetToken = IERC20(asset);
        FundingAccount storage a = fundingAccounts[marketId];
        uint256 swapIn = a.queued;
        if (bounded && asset != address(brb) && swapIn > 0) {
            address pair = _assetBrbPair(asset);
            if (pair == address(0)) { emit FundFromMarketSkipped(marketId, asset, SKIP_NO_QUOTE); return; }
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
            uint256 reserveIn = IUniswapV2Pair(pair).token0() == asset ? r0 : r1;
            uint256 cap = Math.mulDiv(reserveIn, maxSwapReserveBps, BPS_DENOM);
            if (cap == 0) { emit FundFromMarketSkipped(marketId, asset, SKIP_NO_QUOTE); return; }
            if (swapIn > cap) swapIn = cap;
        }
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

            uint256 assetBefore = assetToken.balanceOf(address(this));
            uint256 brbBefore = brb.balanceOf(address(this));
            try router.swapExactTokensForTokens(swapIn, amountOutMin, path, address(this), block.timestamp + 600) returns (
                uint256[] memory
            ) {
                brbOut = brb.balanceOf(address(this)) - brbBefore;
                if (brbOut < amountOutMin || assetBefore - assetToken.balanceOf(address(this)) != swapIn) revert InsufficientBalance();
            } catch {
                emit FundFromMarketSkipped(marketId, asset, SKIP_SWAP_REVERTED);
            }

            assetToken.forceApprove(address(router), 0);

            if (brbOut > 0) {
                _snapshotPairObservation(asset);
            }
        }

        if (brbOut == 0) return;

        a.queued -= swapIn;
        queuedAssetTotals[asset] -= swapIn;
        a.processed += swapIn;
        a.brbProduced += brbOut;
        uint256 toTreasury = Math.mulDiv(brbOut, treasuryBrbNumerator, treasuryBrbDenominator);
        uint256 toBurn = brbOut - toTreasury;

        (uint256 sentTreasury, uint256 burnedAmt) = _distributeBrb(marketId, toTreasury, toBurn);
        emit FundedFromMarket(marketId, asset, swapIn, brbOut, sentTreasury, burnedAmt);
    }

    function _distributeBrb(uint32 marketId, uint256 toTreasury, uint256 toBurn)
        private returns (uint256 sentTreasury, uint256 burnedAmt)
    {
        if (toTreasury > 0) {
            try brb.transfer(jackpotTreasury, toTreasury) returns (bool ok) {
                if (ok) {
                    sentTreasury = toTreasury;
                    fundingAccounts[marketId].treasuryPaid += toTreasury;
                } else {
                    pendingBrbByMarket[marketId].treasury += toTreasury;
                    pendingTreasuryBrb += toTreasury;
                    emit JackpotTreasuryTransferFailed(marketId, jackpotTreasury, toTreasury);
                }
            } catch {
                pendingBrbByMarket[marketId].treasury += toTreasury;
                pendingTreasuryBrb += toTreasury;
                emit JackpotTreasuryTransferFailed(marketId, jackpotTreasury, toTreasury);
            }
        }

        if (toBurn > 0) {
            try IERC20BurnFromSelf(address(brb)).burn(toBurn) {
                burnedAmt = toBurn;
                fundingAccounts[marketId].burned += toBurn;
            } catch {
                pendingBrbByMarket[marketId].burn += toBurn;
                pendingBurnBrb += toBurn;
                emit JackpotBurnFailed(marketId, toBurn);
            }
        }

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
            uint256 twapOut = UniswapV2TwapLib.quoteExecutableTwapAmountOut(pair, asset, swapIn, obs, nowTs);
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

        // Roll the anchor forward only once the previous sample has aged past the window, so the
        // anchor keeps a >= `twapWindowSeconds` lookback instead of being reset by every swap.
        uint32 window = twapWindowSeconds;
        if (window == 0) {
            pairObservations[pair] = sample;
            pendingPairObservations[pair] = sample;
            emit PairObservationUpdated(pair, timestamp);
        } else if (pending.timestamp == pairObservations[pair].timestamp) {
            pendingPairObservations[pair] = sample;
        } else if (timestamp > pending.timestamp && timestamp - pending.timestamp >= window) {
            pairObservations[pair] = pending;
            pendingPairObservations[pair] = sample;
            emit PairObservationUpdated(pair, pending.timestamp);
        }
    }
}
