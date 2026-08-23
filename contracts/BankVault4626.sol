// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IBankVault } from "./interfaces/IBankVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { ISideBetVault } from "./interfaces/ISideBetVault.sol";
import { IERC20PermitCompat } from "./interfaces/IERC20PermitCompat.sol";

/// @notice Proxy-friendly BankVault4626 (initializer-based). Deploy via `ERC1967Proxy`.
/// @dev Deposit / withdraw enqueue policy follows `ENGINE.isBankLiquidityRestricted(marketId)`. Queue limits and batch sizes are read from the engine (global per protocol).
contract BankVault4626 is
    Initializable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardTransient,
    IBankVault,
    ISideBetVault
{
    using SafeERC20 for IERC20;

    uint16 internal constant BPS_DENOM = 10_000;

    struct InitializeParams {
        address assetToken;
        string name;
        string symbol;
        uint32 marketId;
        address engine;
        address admin;
        uint256 minBet;
        address sideBetController;
    }

    bytes32 public constant BANK_ADMIN_ROLE = keccak256("BANK_ADMIN_ROLE");

    /// @custom:storage-location erc7201:biribi.storage.BankVault4626
    struct BankVaultStorage {
        uint32 marketId;
        IRouletteEngine ENGINE;
        uint256 lockedBetLiquidity;
        address sideBetController;
        uint256 minBet;
        uint8 assetDecimals;
        uint256 flatWithdrawFee;
        address[] _withdrawalQueue;
        uint256 _queueHead;
        mapping(address => QueuedWithdrawal) _pendingWithdrawal;
        mapping(address => uint256) _userQueueIndex;
    }

    // keccak256(abi.encode(uint256(keccak256("biribi.storage.BankVault4626")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant BANK_VAULT_STORAGE_LOCATION =
        0xb0c430920bd46af8c5ecb68ebf1a5f6f3805a863a6d4fa0fa5e65feb72f8e800;

    function _s() private pure returns (BankVaultStorage storage $) {
        assembly {
            $.slot := BANK_VAULT_STORAGE_LOCATION
        }
    }

    function marketId() external view override returns (uint32) {
        return _s().marketId;
    }

    function ENGINE() external view returns (IRouletteEngine) {
        return _s().ENGINE;
    }

    function lockedBetLiquidity() external view returns (uint256) {
        return _s().lockedBetLiquidity;
    }

    function sideBetController() external view returns (address) {
        return _s().sideBetController;
    }

    function availableForSideBet() public view returns (uint256) {
        return totalAssets();
    }

    function minBet() external view override returns (uint256) {
        return _s().minBet;
    }

    function assetDecimals() external view returns (uint8) {
        return _s().assetDecimals;
    }

    /// @notice Flat fee (1 whole token unit) charged on each processed queued withdrawal; retained in the vault for LPs.
    function flatWithdrawFee() external view returns (uint256) {
        return _s().flatWithdrawFee;
    }

    error OnlyEngine();
    error UnauthorizedSettlementCaller();
    error InvalidAssetDecimals();
    error ZeroAmount();
    error BetTooSmall();
    error DepositTooSmall();
    error InvalidBps();
    error DepositBlockedDuringResolution();
    error WithdrawalBlockedDuringResolution();
    error WithdrawalPending();
    error UnauthorizedCaller();
    error InvalidReceiver();
    error QueueFull();
    error OnlySideBet();
    error InsufficientSideBetLiquidity();

    /// @dev ABI-aligned with legacy `StakedBRB.BetPlaced`; `marketId` is implicit (this vault's `marketId()`).
    event BetPlaced(address user, uint256 amount, bytes data, uint256 roundId);
    event MinBetUpdated(uint256 previousMinBet, uint256 newMinBet);
    event BetsReleased(uint256 amount, uint256 newLockedTotal);
    event PayoutBatchProcessed(uint256 payoutCount, uint256 totalPaid);
    event FundsTransferred(address recipient, uint256 amount);
    event WithdrawalRequested(address owner, uint16 bps, address receiver);
    event WithdrawalProcessed(address owner, uint16 bps, address receiver, uint256 assetsPaid, uint256 sharesBurned);
    event SideBetControllerUpdated(address previousController, address newController);
    event SideBetStakeLocked(address player, uint256 stake, uint256 payoutReserve, uint256 newLockedTotal);

    modifier onlyEngine() {
        if (msg.sender != address(_s().ENGINE)) revert OnlyEngine();
        _;
    }

    modifier onlySideBet() {
        if (msg.sender != _s().sideBetController) revert OnlySideBet();
        _;
    }

    /// @dev Roulette engine or the configured {SideBet} module may settle via `releaseBets` / `payoutBatch` / `transferOut`.
    modifier onlyEngineOrSideBet() {
        BankVaultStorage storage $ = _s();
        if (msg.sender != address($.ENGINE) && msg.sender != $.sideBetController) {
            revert UnauthorizedSettlementCaller();
        }
        _;
    }

    function initialize(InitializeParams calldata p) external initializer {
        if (p.minBet == 0) revert ZeroAmount();
        __ERC20_init(p.name, p.symbol);
        __ERC4626_init(IERC20(p.assetToken));
        __AccessControl_init();

        uint8 decimals = IERC20Metadata(p.assetToken).decimals();
        if (decimals > 77) revert InvalidAssetDecimals();

        BankVaultStorage storage $ = _s();
        $.marketId = p.marketId;
        $.ENGINE = IRouletteEngine(p.engine);
        $.minBet = p.minBet;
        $.assetDecimals = decimals;
        $.flatWithdrawFee = 10 ** uint256(decimals);
        $.sideBetController = p.sideBetController;

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(BANK_ADMIN_ROLE, p.admin);

        if (p.sideBetController != address(0)) {
            emit SideBetControllerUpdated(address(0), p.sideBetController);
        }
    }

    function setSideBetController(address newController) external onlyRole(BANK_ADMIN_ROLE) {
        if (newController == address(0)) revert ZeroAmount();
        BankVaultStorage storage $ = _s();
        address previous = $.sideBetController;
        $.sideBetController = newController;
        emit SideBetControllerUpdated(previous, newController);
    }

    function lockSideBetStake(address player, uint256 stake, uint256 payoutReserve) public virtual onlySideBet {
        if (player == address(0) || stake == 0) revert ZeroAmount();
        BankVaultStorage storage $ = _s();
        uint256 free = availableForSideBet();
        // `lockedBetLiquidity` holds roulette stakes but never the worst case they can pay out, so
        // free liquidity alone overstates what a side bet may reserve. The engine's solvency check
        // is not re-run after the last bet, so without this a side bet placed late could quietly
        // take liquidity the round still owes its winners.
        uint256 rouletteNeed = $.ENGINE.marketRouletteLiquidityNeed($.marketId);
        free = free > rouletteNeed ? free - rouletteNeed : 0;
        if (free + stake < payoutReserve) revert InsufficientSideBetLiquidity();
        IERC20(asset()).safeTransferFrom(player, address(this), stake);
        $.lockedBetLiquidity += payoutReserve;
        emit SideBetStakeLocked(player, stake, payoutReserve, $.lockedBetLiquidity);
    }

    function setMinBet(uint256 newMinBet) external onlyRole(BANK_ADMIN_ROLE) {
        if (newMinBet == 0) revert ZeroAmount();
        BankVaultStorage storage $ = _s();
        uint256 previous = $.minBet;
        $.minBet = newMinBet;
        emit MinBetUpdated(previous, newMinBet);
    }

    function placeBet(uint256 amount, bytes calldata betData, address referral) external {
        _placeBetCore(amount, betData, referral);
    }

    function placeBetWithPermit(
        uint256 amount,
        bytes calldata betData,
        address referral,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (amount == 0) revert ZeroAmount();
        try IERC20PermitCompat(address(asset())).permit(msg.sender, address(this), amount, deadline, v, r, s) {
            // solhint-disable-next-line no-empty-blocks
        } catch {}
        _placeBetCore(amount, betData, referral);
    }

    function _placeBetCore(uint256 amount, bytes calldata betData, address referral) private nonReentrant {
        BankVaultStorage storage $ = _s();
        if (amount < $.minBet) revert BetTooSmall();
        $.lockedBetLiquidity += amount;
        $.ENGINE.recordBet($.marketId, msg.sender, amount, betData, referral);
        emit BetPlaced(msg.sender, amount, betData, $.ENGINE.currentGlobalRound());
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    function releaseBets(uint256 amount) public virtual onlyEngineOrSideBet {
        BankVaultStorage storage $ = _s();
        if (amount > $.lockedBetLiquidity) $.lockedBetLiquidity = 0;
        else $.lockedBetLiquidity -= amount;
        emit BetsReleased(amount, $.lockedBetLiquidity);
    }

    function payoutBatch(Payout[] calldata payouts) external onlyEngineOrSideBet returns (uint256 totalPaid) {
        IERC20 token = IERC20(asset());
        uint256 length = payouts.length;
        Payout calldata payout;
        for (uint256 i; i < length; ) {
            payout = payouts[i];
            token.safeTransfer(payout.player, payout.amount);
            totalPaid += payout.amount;
            unchecked {
                ++i;
            }
        }
        emit PayoutBatchProcessed(length, totalPaid);
        return totalPaid;
    }

    function transferOut(address recipient, uint256 amount) external onlyEngineOrSideBet {
        IERC20(asset()).safeTransfer(recipient, amount);
        emit FundsTransferred(recipient, amount);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override(ERC4626Upgradeable, IBankVault)
        returns (uint256 shares)
    {
        uint16 bps = _assetsToBps(owner, assets);
        shares = _sharesForBps(owner, bps);
        _enqueueWithdrawal(owner, bps, receiver);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override(ERC4626Upgradeable, IBankVault)
        returns (uint256 assets)
    {
        uint16 bps = _sharesToBps(owner, shares);
        assets = previewRedeem(_sharesForBps(owner, bps));
        _enqueueWithdrawal(owner, bps, receiver);
    }

    function redeemBps(uint16 bps, address receiver, address owner) external returns (uint256 assets) {
        if (bps == 0 || bps > BPS_DENOM) revert InvalidBps();
        if (receiver == address(0)) revert InvalidReceiver();
        if (owner != msg.sender) revert UnauthorizedCaller();
        _assertCanEnqueue(owner);
        assets = previewRedeem(_sharesForBps(owner, bps));
        _enqueueWithdrawal(owner, bps, receiver);
    }

    function processWithdrawalQueue(uint256 maxCount) external override onlyEngine returns (uint256 processed) {
        return _processQueue(maxCount);
    }

    /// @notice Drain the withdrawal queue without waiting for a settlement.
    /// @dev The engine only drains the queue from `_finalizeMarketSettlement`, which is reached only
    /// for a market that had bets in the round. A market with no betting activity — or a protocol
    /// with none at all — therefore never drains, and a queued LP cannot even re-request
    /// (`_assertCanEnqueue` reverts while one is pending). This is the escape hatch. It is
    /// permissionless because the queue pays its own owners at their own NAV, but it must not run
    /// while the round is resolving: `releaseBets` zeroes `lockedBetLiquidity` before winners are
    /// paid, so LPs could otherwise exit ahead of them. Refusing at zero NAV matters too — the queue
    /// burns shares whether or not it can pay, so draining a fully-locked vault would burn for
    /// nothing. Deliberately NOT requiring `lockedBetLiquidity == 0`: one open dust side bet would
    /// then be enough to block the hatch for everyone.
    function drainWithdrawalQueue(uint256 maxCount) external nonReentrant returns (uint256 processed) {
        BankVaultStorage storage $ = _s();
        if ($.ENGINE.isBankLiquidityRestricted($.marketId)) revert WithdrawalBlockedDuringResolution();
        if (totalAssets() == 0) revert ZeroAmount();
        uint256 cap = $.ENGINE.withdrawalQueueBatchSize();
        return _processQueue(maxCount > cap ? cap : maxCount);
    }

    function _processQueue(uint256 maxCount) private returns (uint256 processed) {
        BankVaultStorage storage $ = _s();
        uint256 head = $._queueHead;
        uint256 len = $._withdrawalQueue.length;
        IERC20 token = IERC20(asset());
        uint256 fee = $.flatWithdrawFee;
        address owner;
        QueuedWithdrawal memory q;
        uint256 shares;
        uint256 paid;
        uint256 gross;
        uint256 net;

        while (processed < maxCount && head < len) {
            owner = $._withdrawalQueue[head];
            q = $._pendingWithdrawal[owner];
            delete $._pendingWithdrawal[owner];
            delete $._userQueueIndex[owner];
            unchecked {
                ++head;
            }

            shares = _sharesForBps(owner, q.bps);
            paid = 0;
            if (shares != 0) {
                gross = convertToAssets(shares);
                _burn(owner, shares);
                if (gross > fee) {
                    net = gross - fee;
                    paid = net;
                    token.safeTransfer(q.receiver, paid);
                }
            }

            emit WithdrawalProcessed(owner, q.bps, q.receiver, paid, shares);

            unchecked {
                ++processed;
            }
        }

        $._queueHead = head;
        if (head == len && head != 0) {
            delete $._withdrawalQueue;
            $._queueHead = 0;
        }
    }

    function _assertCanEnqueue(address owner) private view {
        BankVaultStorage storage $ = _s();
        if ($.ENGINE.isBankLiquidityRestricted($.marketId)) revert WithdrawalBlockedDuringResolution();
        if ($._pendingWithdrawal[owner].bps != 0) revert WithdrawalPending();
        if ($._withdrawalQueue.length - $._queueHead >= $.ENGINE.maxWithdrawalQueueLength()) revert QueueFull();
    }

    function _enqueueWithdrawal(address owner, uint16 bps, address receiver) internal {
        if (receiver == address(0)) revert InvalidReceiver();
        if (owner != msg.sender) revert UnauthorizedCaller();
        // An address with no position can never be paid out, but its request still consumes one of
        // the queue's bounded slots. `withdraw`/`redeem` already reject empty positions upstream;
        // without this, `redeemBps` let sybils fill the queue faster than settlement drains it and
        // lock genuine LPs out behind `QueueFull`. Holders are unaffected: shares are not escrowed,
        // so a queued request whose position empties later is still absorbed by the queue.
        if (balanceOf(owner) == 0) revert ZeroAmount();
        _assertCanEnqueue(owner);

        BankVaultStorage storage $ = _s();
        $._pendingWithdrawal[owner] = QueuedWithdrawal({ bps: bps, receiver: receiver });
        uint256 idx = $._withdrawalQueue.length;
        $._userQueueIndex[owner] = idx;
        $._withdrawalQueue.push(owner);
        emit WithdrawalRequested(owner, bps, receiver);
    }

    function _assetsToBps(address owner, uint256 assets) private view returns (uint16) {
        if (assets == 0) revert ZeroAmount();
        uint256 positionAssets = convertToAssets(balanceOf(owner));
        if (positionAssets == 0) revert ZeroAmount();
        if (assets > positionAssets) assets = positionAssets;
        uint256 bps = assets * BPS_DENOM / positionAssets;
        if (bps == 0) revert ZeroAmount();
        return uint16(bps);
    }

    function _sharesToBps(address owner, uint256 shares) private view returns (uint16) {
        if (shares == 0) revert ZeroAmount();
        uint256 balance = balanceOf(owner);
        if (balance == 0) revert ZeroAmount();
        if (shares >= balance) return BPS_DENOM;
        uint256 bps = shares * BPS_DENOM / balance;
        if (bps == 0) revert ZeroAmount();
        return uint16(bps);
    }

    function _sharesForBps(address owner, uint16 bps) private view returns (uint256) {
        if (bps == 0) return 0;
        uint256 balance = balanceOf(owner);
        if (balance == 0) return 0;
        if (bps == BPS_DENOM) return balance;
        return balance * bps / BPS_DENOM;
    }

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        BankVaultStorage storage $ = _s();
        if (assets <= $.flatWithdrawFee) revert DepositTooSmall();
        if ($.ENGINE.isBankLiquidityRestricted($.marketId)) revert DepositBlockedDuringResolution();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        BankVaultStorage storage $ = _s();
        uint256 assets = previewMint(shares);
        if (assets <= $.flatWithdrawFee) revert DepositTooSmall();
        if ($.ENGINE.isBankLiquidityRestricted($.marketId)) revert DepositBlockedDuringResolution();
        return super.mint(shares, receiver);
    }

    function totalAssets() public view override returns (uint256) {
        uint256 locked = _s().lockedBetLiquidity;
        uint256 gross = IERC20(asset()).balanceOf(address(this));
        return gross > locked ? gross - locked : 0;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 base = super.maxRedeem(owner);
        uint256 freeLiquidityShares = convertToShares(totalAssets());
        return base > freeLiquidityShares ? freeLiquidityShares : base;
    }

    /// @inheritdoc ERC4626Upgradeable
    /// @dev Uniform virtual-share offset across all market assets; mitigates ERC-4626 inflation / donation attacks (AUDIT C-2).
    function _decimalsOffset() internal view virtual override returns (uint8) {
        return 6;
    }
}
