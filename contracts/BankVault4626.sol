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

/// @notice Proxy-friendly BankVault4626 (initializer-based). Deploy via `BeaconProxy`.
/// @dev Deposit / withdraw enqueue policy follows `ENGINE.isBankLiquidityRestricted(marketId)`. Queue limits and batch sizes are read from the engine (global per protocol).
///
/// Audit fixes (Critical + High) vs initial `markets`-branch implementation:
/// - C-2: ERC-4626 first-deposit inflation attack mitigated via `_decimalsOffset() == 6`.
/// - C-3: `__gap` reserved at the end of this contract's storage to protect upgrades.
/// - H-9: `_placeBetCore` measures the actual received delta — fee-on-transfer assets that net zero revert.
/// - H-11: `minBet` is enforced non-zero at `initialize` time (no dust-bet griefing window).
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

    /// @dev Storage gap reserved for future state additions. Decrement when adding
    /// new state variables to keep the inherited layout stable across beacon upgrades.
    uint256[50] private __gap;

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
    error FeeOnTransferAsset();
    error InvalidInitParams();

    /// @dev ABI-aligned with legacy `StakedBRB.BetPlaced`; `marketId` is implicit (this vault's `marketId()`).
    /// `amount` is the effective (post-transfer) amount the bank received.
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

    /// @notice Initializer. `minBet_` MUST be non-zero in production to avoid dust-bet griefing.
    /// @dev Pass an asset-appropriate value (e.g. `1e6` for USDC = $1; `1e18` for 18-decimal stables / BRB).
    function initialize(
        address assetToken_,
        string calldata name_,
        string calldata symbol_,
        uint32 marketId_,
        address engine_,
        address admin,
        uint256 minBet_
    ) external initializer {
        if (assetToken_ == address(0) || engine_ == address(0) || admin == address(0)) revert InvalidInitParams();
        if (minBet_ == 0) revert ZeroAmount();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(IERC20(assetToken_));
        __AccessControl_init();

        marketId = marketId_;
        ENGINE = IRouletteEngine(engine_);
        minBet = minBet_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BANK_ADMIN_ROLE, admin);

        emit MinBetUpdated(0, minBet_);
    }

    /// @notice Increases the share-to-asset offset to mitigate the ERC-4626 first-depositor inflation attack.
    /// @dev OZ v5 recommendation. With offset = 6, the attacker would need to donate ≥ 1e6 asset units to make rounding bite.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
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

    /// @dev Measures the actual received delta on the asset to be fee-on-transfer-safe.
    /// The check `effectiveAmount < minBet` runs AFTER the transfer so the engine
    /// receives the true wagered amount and `lockedBetLiquidity` matches the on-chain
    /// balance. Reverts with `FeeOnTransferAsset` if the bank received nothing.
    function _placeBetCore(uint256 amount, bytes calldata betData) private nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(asset());
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 effectiveAmount;
        unchecked {
            // Solvent ERC-20s only grow the balance; fee-on-transfer assets net less, never more.
            effectiveAmount = balanceAfter - balanceBefore;
        }
        if (effectiveAmount == 0) revert FeeOnTransferAsset();
        if (effectiveAmount < minBet) revert BetTooSmall();

        lockedBetLiquidity += effectiveAmount;
        ENGINE.recordBet(marketId, msg.sender, effectiveAmount, betData);
        emit BetPlaced(msg.sender, effectiveAmount, betData, ENGINE.currentGlobalRound());
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
