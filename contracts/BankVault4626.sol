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
import { IERC20PermitCompat } from "./interfaces/IERC20PermitCompat.sol";

/// @notice Proxy-friendly BankVault4626 (initializer-based). Deploy via `ERC1967Proxy`.
/// @dev Deposit / withdraw enqueue policy follows `ENGINE.isBankLiquidityRestricted(marketId)`. Queue limits and batch sizes are read from the engine (global per protocol).
contract BankVault4626 is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, ReentrancyGuardTransient, IBankVault {
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
    }

    bytes32 public constant BANK_ADMIN_ROLE = keccak256("BANK_ADMIN_ROLE");

    /// @custom:storage-location erc7201:biribi.storage.BankVault4626
    struct BankVaultStorage {
        uint32 marketId;
        IRouletteEngine ENGINE;
        uint256 lockedBetLiquidity;
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

    /// @dev ABI-aligned with legacy `StakedBRB.BetPlaced`; `marketId` is implicit (this vault's `marketId()`).
    event BetPlaced(address user, uint256 amount, bytes data, uint256 roundId);
    event MinBetUpdated(uint256 previousMinBet, uint256 newMinBet);
    event BetsReleased(uint256 amount, uint256 newLockedTotal);
    event PayoutBatchProcessed(uint256 payoutCount, uint256 totalPaid);
    event FundsTransferred(address recipient, uint256 amount);
    event WithdrawalRequested(address owner, uint16 bps, address receiver);
    event WithdrawalProcessed(address owner, uint16 bps, address receiver, uint256 assetsPaid, uint256 sharesBurned);

    modifier onlyEngine() {
        if (msg.sender != address(_s().ENGINE)) revert OnlyEngine();
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

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(BANK_ADMIN_ROLE, p.admin);
    }

    function setMinBet(uint256 newMinBet) external onlyRole(BANK_ADMIN_ROLE) {
        if (newMinBet == 0) revert ZeroAmount();
        BankVaultStorage storage $ = _s();
        uint256 previous = $.minBet;
        $.minBet = newMinBet;
        emit MinBetUpdated(previous, newMinBet);
    }

    function placeBet(uint256 amount, bytes calldata betData) external {
        _placeBetCore(amount, betData);
    }

    function placeBetWithPermit(
        uint256 amount,
        bytes calldata betData,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (amount == 0) revert ZeroAmount();
        try IERC20PermitCompat(address(asset())).permit(msg.sender, address(this), amount, deadline, v, r, s) {
            // solhint-disable-next-line no-empty-blocks
        } catch {}
        _placeBetCore(amount, betData);
    }

    function _placeBetCore(uint256 amount, bytes calldata betData) private nonReentrant {
        BankVaultStorage storage $ = _s();
        if (amount < $.minBet) revert BetTooSmall();
        $.lockedBetLiquidity += amount;
        $.ENGINE.recordBet($.marketId, msg.sender, amount, betData);
        emit BetPlaced(msg.sender, amount, betData, $.ENGINE.currentGlobalRound());
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    function releaseBets(uint256 amount) external onlyEngine {
        BankVaultStorage storage $ = _s();
        if (amount > $.lockedBetLiquidity) $.lockedBetLiquidity = 0;
        else $.lockedBetLiquidity -= amount;
        emit BetsReleased(amount, $.lockedBetLiquidity);
    }

    function payoutBatch(Payout[] calldata payouts) external onlyEngine returns (uint256 totalPaid) {
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

    function transferOut(address recipient, uint256 amount) external onlyEngine {
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
        BankVaultStorage storage $ = _s();
        uint256 head = $._queueHead;
        uint256 len = $._withdrawalQueue.length;
        IERC20 token = IERC20(asset());
        uint256 fee = $.flatWithdrawFee;

        while (processed < maxCount && head < len) {
            address owner = $._withdrawalQueue[head];
            QueuedWithdrawal memory q = $._pendingWithdrawal[owner];
            delete $._pendingWithdrawal[owner];
            delete $._userQueueIndex[owner];
            unchecked {
                ++head;
            }

            uint256 shares = _sharesForBps(owner, q.bps);
            uint256 paid;
            if (shares != 0) {
                uint256 gross = convertToAssets(shares);
                _burn(owner, shares);
                if (gross > fee) {
                    uint256 net = gross - fee;
                    uint256 balance = token.balanceOf(address(this));
                    paid = net > balance ? balance : net;
                    if (paid > 0) {
                        token.safeTransfer(q.receiver, paid);
                    }
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

    function _enqueueWithdrawal(address owner, uint16 bps, address receiver) private {
        if (receiver == address(0)) revert InvalidReceiver();
        if (owner != msg.sender) revert UnauthorizedCaller();
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

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 base = super.maxWithdraw(owner);
        uint256 freeLiquidity = totalAssets();
        return base > freeLiquidity ? freeLiquidity : base;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 base = super.maxRedeem(owner);
        uint256 freeLiquidityShares = convertToShares(totalAssets());
        return base > freeLiquidityShares ? freeLiquidityShares : base;
    }
}
