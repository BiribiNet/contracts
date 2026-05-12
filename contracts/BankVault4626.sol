// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IBankVault } from "./interfaces/IBankVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IERC20PermitCompat } from "./interfaces/IERC20PermitCompat.sol";

/// @notice Proxy-friendly BankVault4626 (initializer-based). Deploy via `ERC1967Proxy`.
/// @dev Deposit / withdraw enqueue policy follows `ENGINE.isBankLiquidityRestricted(marketId)`. Queue limits and batch sizes are read from the engine (global per protocol).
contract BankVault4626 is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, ReentrancyGuardTransient, IBankVault {
    using SafeERC20 for IERC20;

    bytes32 public constant BANK_ADMIN_ROLE = keccak256("BANK_ADMIN_ROLE");

    uint32 public override marketId;
    IRouletteEngine public ENGINE;

    uint256 public lockedBetLiquidity;
    uint256 public override minBet;

    address[] private _withdrawalQueue;
    uint256 private _queueHead;
    mapping(address => QueuedWithdrawal) private _pendingWithdrawal;
    mapping(address => uint256) private _userQueueIndex;

    error OnlyEngine();
    error ZeroAmount();
    error BetTooSmall();
    error DepositBlockedDuringResolution();
    error WithdrawalBlockedDuringResolution();
    error CancelWithdrawalBlockedDuringResolution();
    error WithdrawalPending();
    error NoWithdrawalPending();
    error UnauthorizedCaller();
    error InvalidReceiver();
    error QueueFull();

    /// @dev ABI-aligned with legacy `StakedBRB.BetPlaced`; `marketId` is implicit (this vault's `marketId()`).
    event BetPlaced(address user, uint256 amount, bytes data, uint256 roundId);
    event MinBetUpdated(uint256 previousMinBet, uint256 newMinBet);
    event BetsReleased(uint256 amount, uint256 newLockedTotal);
    event PayoutBatchProcessed(uint256 payoutCount, uint256 totalPaid);
    event FundsTransferred(address recipient, uint256 amount);
    event WithdrawalRequested(address owner, uint8 kind, address receiver, uint256 assets, uint256 shares);
    event WithdrawalProcessed(address owner, uint8 kind, address receiver, uint256 assets, uint256 shares);
    event WithdrawalEjected(address owner, uint8 reason);

    modifier onlyEngine() {
        if (msg.sender != address(ENGINE)) revert OnlyEngine();
        _;
    }

    function initialize(
        address assetToken_,
        string calldata name_,
        string calldata symbol_,
        uint32 marketId_,
        address engine_,
        address admin
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC4626_init(IERC20(assetToken_));
        __AccessControl_init();

        marketId = marketId_;
        ENGINE = IRouletteEngine(engine_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BANK_ADMIN_ROLE, admin);
    }

    function setMinBet(uint256 newMinBet) external onlyRole(BANK_ADMIN_ROLE) {
        if (newMinBet == 0) revert ZeroAmount();
        uint256 previous = minBet;
        minBet = newMinBet;
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
        if (amount == 0) revert ZeroAmount();
        if (amount < minBet) revert BetTooSmall();
        lockedBetLiquidity += amount;
        ENGINE.recordBet(marketId, msg.sender, amount, betData);
        emit BetPlaced(msg.sender, amount, betData, ENGINE.currentGlobalRound());
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    function releaseBets(uint256 amount) external onlyEngine {
        if (amount > lockedBetLiquidity) lockedBetLiquidity = 0;
        else lockedBetLiquidity -= amount;
        emit BetsReleased(amount, lockedBetLiquidity);
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
        if (amount == 0) return;
        IERC20(asset()).safeTransfer(recipient, amount);
        emit FundsTransferred(recipient, amount);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override(ERC4626Upgradeable, IBankVault)
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert InvalidReceiver();
        if (owner != msg.sender) revert UnauthorizedCaller();
        if (ENGINE.isBankLiquidityRestricted(marketId)) revert WithdrawalBlockedDuringResolution();
        if (_pendingWithdrawal[owner].kind != 0) revert WithdrawalPending();
        if (_withdrawalQueue.length - _queueHead >= ENGINE.maxWithdrawalQueueLength()) revert QueueFull();

        shares = previewWithdraw(assets);
        _enqueueWithdrawal(owner, QueuedWithdrawal({ kind: 1, receiver: receiver, assets: assets, shares: 0 }));
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override(ERC4626Upgradeable, IBankVault)
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert InvalidReceiver();
        if (owner != msg.sender) revert UnauthorizedCaller();
        if (ENGINE.isBankLiquidityRestricted(marketId)) revert WithdrawalBlockedDuringResolution();
        if (_pendingWithdrawal[owner].kind != 0) revert WithdrawalPending();
        if (_withdrawalQueue.length - _queueHead >= ENGINE.maxWithdrawalQueueLength()) revert QueueFull();

        assets = previewRedeem(shares);
        _enqueueWithdrawal(owner, QueuedWithdrawal({ kind: 2, receiver: receiver, assets: 0, shares: shares }));
    }

    function cancelWithdrawal() external override {
        if (ENGINE.isBankLiquidityRestricted(marketId)) revert CancelWithdrawalBlockedDuringResolution();
        QueuedWithdrawal memory q = _pendingWithdrawal[msg.sender];
        if (q.kind == 0) revert NoWithdrawalPending();
        delete _pendingWithdrawal[msg.sender];

        uint256 idx = _userQueueIndex[msg.sender];
        if (idx < _withdrawalQueue.length && _withdrawalQueue[idx] == msg.sender) {
            _withdrawalQueue[idx] = address(0);
        }
        delete _userQueueIndex[msg.sender];
        emit WithdrawalProcessed(msg.sender, 0, address(0), 0, 0);
    }

    function processWithdrawalQueue(uint256 maxCount) external override onlyEngine returns (uint256 processed) {
        uint256 head = _queueHead;
        uint256 len = _withdrawalQueue.length;
        IERC20 token = IERC20(asset());

        while (processed < maxCount && head < len) {
            address owner = _withdrawalQueue[head];
            _withdrawalQueue[head] = address(0);
            unchecked {
                ++head;
            }
            if (owner == address(0)) continue;

            QueuedWithdrawal memory q = _pendingWithdrawal[owner];
            if (q.kind == 0) continue;
            delete _pendingWithdrawal[owner];
            delete _userQueueIndex[owner];

            if (q.kind == 1) {
                uint256 sh = previewWithdraw(q.assets);
                if (sh > balanceOf(owner)) {
                    emit WithdrawalEjected(owner, 2);
                    continue;
                }
                uint256 free = token.balanceOf(address(this));
                if (free < q.assets + lockedBetLiquidity) {
                    emit WithdrawalEjected(owner, 3);
                    continue;
                }
                _withdraw(owner, q.receiver, owner, q.assets, sh);
                emit WithdrawalProcessed(owner, 1, q.receiver, q.assets, sh);
            } else {
                if (q.shares > balanceOf(owner)) {
                    emit WithdrawalEjected(owner, 2);
                    continue;
                }
                uint256 aOut = previewRedeem(q.shares);
                uint256 free = token.balanceOf(address(this));
                if (free < aOut + lockedBetLiquidity) {
                    emit WithdrawalEjected(owner, 3);
                    continue;
                }
                _withdraw(owner, q.receiver, owner, aOut, q.shares);
                emit WithdrawalProcessed(owner, 2, q.receiver, aOut, q.shares);
            }

            unchecked {
                ++processed;
            }
        }

        _queueHead = head;
        if (head == len && head != 0) {
            delete _withdrawalQueue;
            _queueHead = 0;
        }
    }

    function _enqueueWithdrawal(address owner, QueuedWithdrawal memory q) private {
        _pendingWithdrawal[owner] = q;
        uint256 idx = _withdrawalQueue.length;
        _userQueueIndex[owner] = idx;
        _withdrawalQueue.push(owner);
        emit WithdrawalRequested(owner, q.kind, q.receiver, q.assets, q.shares);
    }

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        if (ENGINE.isBankLiquidityRestricted(marketId)) revert DepositBlockedDuringResolution();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        if (ENGINE.isBankLiquidityRestricted(marketId)) revert DepositBlockedDuringResolution();
        return super.mint(shares, receiver);
    }

    function totalAssets() public view override returns (uint256) {
        uint256 gross = IERC20(asset()).balanceOf(address(this));
        return gross > lockedBetLiquidity ? gross - lockedBetLiquidity : 0;
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
