// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { RouletteClean } from "./RouletteClean.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";

/**
 * @title StakedBRB Unified
 * @dev ERC4626 vault with built-in roulette betting and protocol fees
 * @dev Uses OpenZeppelin's ERC4626Fees pattern for clean fee handling
 * @dev Handles staking, betting, protocol fees, and roulette integration
 */
contract StakedBRB is ERC4626Upgradeable, AccessControlUpgradeable, UUPSUpgradeable {
    using Math for uint256;
        
    // Immutable addresses for gas optimization
    address private immutable BRB_TOKEN;
    address private immutable ROULETTE_CONTRACT;
    
    // Security constants
    uint256 public constant MINIMUM_DEPOSIT = 1000;
    uint256 public constant MAX_PROTOCOL_FEE = 10000; // 100% max
    uint256 private constant _BASIS_POINT_SCALE = 1e4;
    
    // Storage location for upgradeable pattern
    bytes32 private constant STORAGE_LOCATION = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd00;
    
    struct StakedBRBStorage {
        uint256 protocolFeeBasisPoints;  // Protocol fee taken from betting losses (e.g. 250 = 2.5%)
        address feeRecipient;            // Where protocol fees go
        uint256 totalFeesCollected;      // Total fees collected from betting losses
        uint256 totalProfitsAdded;       // Total staker profits from betting losses
        uint256 totalBetsProcessed;      // Total number of bets processed
        uint256 pendingBets;             // BRB amount in unresolved bets (excluded from totalAssets)
    }
    
    // Events
    event BetPlaced(address indexed user, uint256 amount, bytes data);
    event BetResult(address indexed player, uint256 betAmount, uint256 protocolFee, uint256 stakerProfit, bool isWin);
    event ProfitDistributed(uint256 amount);
    event ProtocolFeeCollected(uint256 amount);
    event ProtocolFeeRateUpdated(uint256 oldFee, uint256 newFee);
    event FeeWithdrawn(uint256 amount, address recipient);
    
    // Errors
    error OnlyBRB();
    error OnlyRoulette();
    error ZeroAmount();
    error InvalidFeeRate();
    error InsufficientBalance();
    error TransferFailed();
    error DepositTooSmall();
    
    modifier onlyBRB() {
        require(msg.sender == BRB_TOKEN, OnlyBRB());
        _;
    }
    
    modifier onlyRoulette() {
        require(msg.sender == ROULETTE_CONTRACT, OnlyRoulette());
        _;
    }
    
    function _getStakedBRBStorage() internal pure returns (StakedBRBStorage storage storageStruct) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            storageStruct.slot := slot
        }
    }
    
    constructor(address brbToken, address rouletteContract) {
        BRB_TOKEN = brbToken;
        ROULETTE_CONTRACT = rouletteContract;
        _disableInitializers();
    }
    
    function initialize(
        address admin,
        uint256 protocolFeeBasisPoints,
        address feeRecipient
    ) external initializer {
        __ERC4626_init(IERC20(BRB_TOKEN));
        __ERC20_init('Staked BRB', 'sBRB');
        __AccessControl_init();
        __UUPSUpgradeable_init();
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        
        if (protocolFeeBasisPoints > MAX_PROTOCOL_FEE) revert InvalidFeeRate();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.protocolFeeBasisPoints = protocolFeeBasisPoints;
        $.feeRecipient = feeRecipient;
    }
    
    /**
     * @dev Returns total assets available to stakers (excludes pending bets)
     * @dev This prevents manipulation from unresolved betting amounts
     */
    function totalAssets() public view override returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 totalBalance = IERC20(asset()).balanceOf(address(this));
        
        // Exclude pending bets from staker assets to prevent sandwich attacks
        return totalBalance > $.pendingBets ? totalBalance - $.pendingBets : 0;
    }
    
    // === ERC4626 Preview Overrides (OpenZeppelin Pattern) ===
    // Note: All fees return 0 since fees are taken from betting losses, not deposits/withdrawals
    
    /// @dev Preview deposit with zero entry fees. See {IERC4626-previewDeposit}.
    function previewDeposit(uint256 assets) public view virtual override returns (uint256) {
        // No entry fees - return standard preview
        return super.previewDeposit(assets);
    }

    /// @dev Preview mint with zero entry fees. See {IERC4626-previewMint}.
    function previewMint(uint256 shares) public view virtual override returns (uint256) {
        // No entry fees - return standard preview
        return super.previewMint(shares);
    }

    /// @dev Preview withdraw with zero exit fees. See {IERC4626-previewWithdraw}.
    function previewWithdraw(uint256 assets) public view virtual override returns (uint256) {
        // No exit fees - return standard preview
        return super.previewWithdraw(assets);
    }

    /// @dev Preview redeem with zero exit fees. See {IERC4626-previewRedeem}.
    function previewRedeem(uint256 shares) public view virtual override returns (uint256) {
        // No exit fees - return standard preview
        return super.previewRedeem(shares);
    }
    
    /**
     * @dev Override deposit to enforce minimum deposit
     */
    function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
        if (assets < MINIMUM_DEPOSIT && totalSupply() == 0) {
            revert DepositTooSmall();
        }
        return super.deposit(assets, receiver);
    }
    
    /**
     * @dev Handle BRB token transfers for betting (ERC677 callback)
     * @param from Address that sent the tokens
     * @param amount Amount of tokens sent
     * @param data Additional data for the bet
     */
    function onTokenTransfer(address from, uint256 amount, bytes calldata data) external onlyBRB {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Track as pending bet (excluded from totalAssets until resolved)
        $.pendingBets += amount;
        
        // Forward the bet to the roulette contract (no longer needs our address as parameter)
        RouletteClean(ROULETTE_CONTRACT).bet(from, amount, data);
        
        emit BetPlaced(from, amount, data);

        // (bool success, bytes memory res) = ROULETTE_CONTRACT.call(abi.encodeWithSelector(RouletteClean.bet.selector, from, amount, data));
        // if (!success) {
        //     assembly {
        //         revert(add(res, 0x20), mload(res))
        //     }
        // }
    }
    
    /**
     * @dev Process roulette results - called by Roulette contract (BATCH PROCESSING)
     * @dev Implements final-batch profit recognition to prevent double reduction and timing attacks
     * @param payouts Array of payout info for multiple winners/losers
     * @param isLastBatch Whether this is the final batch for the current round
     */
    function processRouletteResult(IRoulette.PayoutInfo[] memory payouts, bool isLastBatch) external onlyRoulette {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 payoutsLength = payouts.length;
        uint256 totalBetAmount;
        uint256 totalProtocolFees;
        uint256 totalStakerProfits;
        
        IRoulette.PayoutInfo memory payoutInfo;
        // Process all payouts in a single transaction
        for (uint256 i; i < payoutsLength;) {
            payoutInfo = payouts[i];
            totalBetAmount += payoutInfo.betAmount;
            
            if (payoutInfo.payout > 0) {
                // Player wins - pay out from vault
                emit BetResult(payoutInfo.player, payoutInfo.betAmount, 0, 0, true);
                IERC20(BRB_TOKEN).transfer(payoutInfo.player, payoutInfo.payout);
            }
            // Note: We don't process losers' bets here - they remain in the vault
            // Losers' losses are automatically added to staker profits when we reset pendingBets
            
            unchecked { ++i; }
        }
        
        // Update tracking variables once (batch optimization)
        $.totalBetsProcessed += payoutsLength;
        
        // If this is the last batch, reset pendingBets to zero and recognize all profits
        // This prevents timing attacks by only recognizing profits at the very end
        if (isLastBatch) {
            // Calculate total protocol fees from all remaining pending bets
            uint256 totalPendingBets = $.pendingBets;
            if (totalPendingBets > 0) {
                uint256 protocolFee = _calculateProtocolFee(totalPendingBets);
                uint256 stakerProfit = totalPendingBets - protocolFee;
                
                totalProtocolFees += protocolFee;
                totalStakerProfits += stakerProfit;
                
                // Reset pending bets to zero - all profits now recognized
                $.pendingBets = 0;
            }
        } else {
            // For non-final batches: DON'T decrease pendingBets yet
            // Winners get paid from vault balance (which includes pending bets)
            // pendingBets remains unchanged until final batch to prevent double reduction
            
            // No change to pendingBets - prevents artificial share price inflation
            // totalAssets() calculation remains accurate throughout the round
        }
        
        // Update fee tracking
        if (totalProtocolFees > 0) {
            $.totalFeesCollected += totalProtocolFees;
            emit ProtocolFeeCollected(totalProtocolFees);
        }
        
        // Update staker profit tracking
        if (totalStakerProfits > 0) {
            $.totalProfitsAdded += totalStakerProfits;
            emit ProfitDistributed(totalStakerProfits);
        }
    }
    
    /**
     * @dev Calculate protocol fee from betting loss using OpenZeppelin's math
     * @param lossAmount Amount lost by player
     * @return protocolFee Amount that goes to protocol
     */
    function _calculateProtocolFee(uint256 lossAmount) internal view returns (uint256 protocolFee) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.protocolFeeBasisPoints == 0) return 0;
        
        // Use OpenZeppelin's mulDiv for precise fee calculation
        protocolFee = lossAmount.mulDiv(
            $.protocolFeeBasisPoints, 
            _BASIS_POINT_SCALE, 
            Math.Rounding.Ceil  // Round up to favor protocol slightly
        );
    }
    
    // === Protocol Fee Management ===
    
    /**
     * @dev Update protocol fee rate taken from betting losses (only admin)
     * @param newFeeBasisPoints New fee rate in basis points (e.g., 250 = 2.5%)
     */
    function setProtocolFeeRate(uint256 newFeeBasisPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBasisPoints > MAX_PROTOCOL_FEE) revert InvalidFeeRate();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 oldFee = $.protocolFeeBasisPoints;
        $.protocolFeeBasisPoints = newFeeBasisPoints;
        
        emit ProtocolFeeRateUpdated(oldFee, newFeeBasisPoints);
    }
    
    /**
     * @dev Update fee recipient (only admin)
     * @param newRecipient Address that will receive withdrawn fees
     */
    function setFeeRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0)) revert InvalidFeeRate();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.feeRecipient = newRecipient;
    }
    
    /**
     * @dev Withdraw accumulated protocol fees (only admin)
     * @param amount Amount to withdraw (0 = withdraw all available)
     */
    function withdrawProtocolFees(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        uint256 availableFees = $.totalFeesCollected;
        if (availableFees == 0) revert ZeroAmount();
        
        uint256 withdrawAmount = amount == 0 ? availableFees : amount;
        if (withdrawAmount > availableFees) revert InsufficientBalance();
        
        // Update tracking (fees are already in vault balance)
        $.totalFeesCollected -= withdrawAmount;
        
        // Transfer fees to recipient
        if (!IERC20(BRB_TOKEN).transfer($.feeRecipient, withdrawAmount)) {
            revert TransferFailed();
        }
        
        emit FeeWithdrawn(withdrawAmount, $.feeRecipient);
    }
    
    // === Note: No ERC4626 Fee Overrides ===
    // We use pure ERC4626 without deposit/withdrawal fees
    // All fees come from betting losses, handled in processRouletteResult()
    
    /**
     * @dev Get vault configuration
     */
    function getVaultConfig() external view returns (
        address brbToken,
        address rouletteContract,
        uint256 protocolFeeBasisPoints,
        address feeRecipient,
        uint256 totalFeesCollected,
        uint256 totalBetsProcessed,
        uint256 pendingBets
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return (
            BRB_TOKEN,
            ROULETTE_CONTRACT,
            $.protocolFeeBasisPoints,
            $.feeRecipient,
            $.totalFeesCollected,
            $.totalBetsProcessed,
            $.pendingBets
        );
    }
    
    /**
     * @dev Get staking stats
     */
    function getStakingStats() external view returns (
        uint256 totalShares,
        uint256 totalBRBDeposited,
        uint256 exchangeRate
    ) {
        totalShares = totalSupply();
        totalBRBDeposited = totalAssets();
        exchangeRate = totalShares == 0 ? 1e18 : (totalBRBDeposited * 1e18) / totalShares;
    }
    
    /**
     * @dev Get total profits added from roulette
     */
    function getTotalProfitsAdded() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.totalProfitsAdded;
    }
    
    /**
     * @dev Get total fees collected
     */
    function getTotalFeesCollected() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.totalFeesCollected;
    }
    
    /**
     * @dev Get current protocol fee rate
     */
    function getProtocolFeeRate() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.protocolFeeBasisPoints;
    }
    
    /**
     * @dev Preview protocol fee for a given loss amount
     * @param lossAmount Amount that would be lost in betting
     * @return protocolFee Amount that would go to protocol
     * @return stakerProfit Amount that would go to stakers
     */
    function previewProtocolFee(uint256 lossAmount) external view returns (uint256 protocolFee, uint256 stakerProfit) {
        protocolFee = _calculateProtocolFee(lossAmount);
        stakerProfit = lossAmount - protocolFee;
    }
    
    /**
     * @dev Get current pending bets amount (excluded from totalAssets)
     */
    function getPendingBets() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.pendingBets;
    }
    
    /**
     * @dev Get total vault balance (including pending bets)
     */
    function getTotalBalance() external view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }
    
    /**
     * @dev Get current exchange rate
     */
    function getExchangeRate() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (totalAssets() * 1e18) / supply;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
