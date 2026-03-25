// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC4626Upgradeable } from "./external/ERC4626Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";
import { IERC20Mintable } from "./interfaces/IERC20Mintable.sol";
import { IERC20Burnable } from "./interfaces/IERC20Burnable.sol";
import { IBRB } from "./interfaces/IBRB.sol";
import { IBRBUpkeepManager } from "./interfaces/IBRBUpkeepManager.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { StakedBRBLiquidityEscrow } from "./StakedBRBLiquidityEscrow.sol";

/**
 * @title StakedBRB Unified
 * @dev ERC4626 vault with built-in roulette betting and protocol fees
 * @dev Uses OpenZeppelin's ERC4626Fees pattern for clean fee handling
 * @dev Handles staking, betting, protocol fees, and roulette integration
 */
contract StakedBRB is ERC4626Upgradeable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, AutomationCompatibleInterface {
    using Math for uint256;
        
    // Immutable addresses for gas optimization
    address private immutable BRB_TOKEN;
    address private immutable ROULETTE_CONTRACT;
    address private immutable JACKPOT_CONTRACT;
    IERC20Mintable private immutable BRB_REFERRAL;
    /// @dev Authorizes Chainlink cleaning forwarders registered via {BRBUpkeepManager.registerStakedBrbCleaningUpkeep}.
    address private immutable UPKEEP_MANAGER;
    // Security constants
    uint256 public constant MINIMUM_FIRST_DEPOSIT = 1e18; // 1 BRB — mitigates ERC-4626 inflation attack
    /// @dev Hard cap: sum of all fees cannot exceed 10% — stakers always receive ≥ 90% of net losses
    uint256 public constant MAX_TOTAL_FEE_BPS = 1000;
    /// @dev Per-fee caps prevent any single fee from dominating
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;   // 5% max
    uint256 public constant MAX_JACKPOT_FEE_BPS = 500;    // 5% max
    uint256 public constant MAX_BURN_FEE_BPS = 200;       // 2% max
    /// @dev Minimum withdrawal/redeem to prevent queue griefing (same as first deposit minimum)
    uint256 public constant MINIMUM_WITHDRAWAL = 1e18;   // 1 BRB min
    uint256 private constant _BASIS_POINT_SCALE = 1e4;
    
    // Withdrawal queue constants
    uint256 public constant DEFAULT_WITHDRAWAL_BATCH_SIZE = 5; // Process 5 withdrawals per cleaning round
    /// @dev Admin cannot exceed this; sized to keep `_finalizeWithdrawal` batch work within `CLEANING_UPKEEP_GAS_LIMIT`.
    uint256 public constant MAX_WITHDRAWAL_BATCH_SIZE = 12;

    // Anti-spam constants
    uint256 public constant DEFAULT_MAX_QUEUE_LENGTH = 100;           // Max 100 users in queue
    /// @dev Caps queue length for spam/DoS; processing per round is still limited by `withdrawalBatchSize`.
    uint256 public constant MAX_MAX_QUEUE_LENGTH = 1000;
    
    // EIP-7201 storage location
    // keccak256(abi.encode(uint256(keccak256("biribi.storage.stakedBRB")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant STORAGE_LOCATION = 0x7b581dcbcd2a09d4fb2b3a62da36c59a578cfd322847de62c019307db0c79c00;
    
    /// @dev Registered Chainlink gas limit for cleaning upkeep; admin-set batch/liquidity caps must stay compatible with this budget.
    uint32 public constant CLEANING_UPKEEP_GAS_LIMIT = 2_000_000;
    /// @dev Default deposit/mint queue entries per cleaning `performUpkeep`.
    uint32 public constant DEFAULT_LIQUIDITY_OPS_PER_UPKEEP = 40;
    /// @dev Admin ceiling for liquidity ops (must fit alongside fees, withdrawals, roulette callback in one tx).
    uint32 public constant MAX_LIQUIDITY_OPS_PER_UPKEEP = 80;

    error InsufficientBalanceForMaxPayout();
    error IndexOutOfBounds();
    error QueueIsEmpty();
    error UserNotInQueue();
    struct StakedBRBStorage {
        uint256 jackpotAmount;           // Amount of jackpot
        uint256 jackpotBasisPoints;      // Jackpot fee taken from betting losses (e.g. 250 = 2.5%)
        uint256 burnBasisPoints;         // Burn fee taken from betting losses (e.g. 250 = 2.5%)
        uint256 protocolFeeBasisPoints;  // Protocol fee taken from betting losses (e.g. 250 = 2.5%)
        address feeRecipient;            // Where protocol fees go
        uint256 pendingBets;             // BRB amount in unresolved bets (excluded from totalAssets)
        uint256 totalPayouts;
        uint256 maxPayout;               // Maximum payout for current round
        uint256 currentRound;            // Current active round for betting
        uint256 lastRoundPaid;           // Last round that was fully processed (for tracking active rounds)
        uint256 lastRoundResolved;       // Last round that was resolved (for tracking active rounds)
        /// @dev Start of the betting/deposit window; updated when cleaning upkeep completes (aligns with Roulette lastRoundStartTime).
        uint256 lastRoundBoundaryTimestamp;
        /// @dev True after pre-VRF lock upkeep; cleared when VRF requests (onRoundTransition).
        bool roundResolutionLocked;
        /// @dev True after VRF (onRoundTransition) until cleaning completes.
        bool roundTransitionInProgress;
        
        // Withdrawal queue (all exits go through FIFO; one pending request per user)
        uint256 withdrawalBatchSize; // Number of withdrawals to process per cleaning round
        
        address[] withdrawalQueue; // Dynamic array of users
        /// @dev kind: 0 = none, 1 = withdraw(assets), 2 = redeem(shares)
        mapping(address => QueuedWithdrawal) pendingWithdrawal;
        mapping(address => uint256) userQueuePosition; // User => their position in queue (O(1) access)
        uint256 queueHead; // Index of first user in queue
        uint256 queueTail; // Index of next free slot
        uint256 queueSize; // Number of users currently in queue

        // Anti-spam protection
        uint256 maxQueueLength; // Maximum number of users allowed in queue

        // Deposit/mint queue (BRB held in liquidity escrow until processed)
        QueuedLiquidity[] depositMintQueue;
        uint256 depositMintQueueHead;
        mapping(address => bool) queuedDepositIntentByPayer;
        address liquidityEscrow;

        // Deprecated: legacy forwarder/registrar slots; cleaning uses `UPKEEP_MANAGER` + registrar on StakedBRB.
        mapping(address => uint256) forwarders;
        address keeperRegistrar;
        address keeperRegistry;
        address linkToken;
        /// @dev Max deposit/mint queue entries processed per cleaning upkeep `performUpkeep`.
        uint32 liquidityOpsPerCleaningUpkeep;
    }
    
    struct CheckUpkeepVars {
        uint256 roundToProcess;
        uint256 actualProcessCount;
        uint256 batchSize;
        bool hasWithdrawals;
        uint256 queueLength;
    }

    struct Fees {
        uint256 protocolFees;
        uint256 burnAmount;
        uint256 jackpotAmount;
    }

    struct CleaningUpkeepData {
        uint256 roundId;
        Fees fees;
        bool hasWithdrawals; // Whether to also process withdrawal queue
        address[] usersToProcess; // Pre-computed users to process for withdrawals
        uint256[] amountsToProcess; // Pre-computed amounts for each user
        uint256 actualProcessCount; // Actual number of users to process
    }

    /// @dev Queued ERC4626 deposit/mint executed when cleaning upkeep completes (GAME_PERIOD enqueue only).
    struct QueuedLiquidity {
        uint8 kind; // 0 = deposit(assets), 1 = mint(shares)
        address payer;
        address receiver;
        uint256 assets;
        uint256 shares;
        /// @dev kind 0: min shares at settlement (eject/refund if lower). kind 1: unused.
        uint256 minSharesOut;
    }

    /// @dev kind: 0 = none, 1 = by assets (ERC4626 withdraw), 2 = by shares (ERC4626 redeem)
    struct QueuedWithdrawal {
        uint8 kind;
        address receiver;
        uint256 assets;
        uint256 shares;
        uint256 maxShares;
        uint256 minAssets;
        uint256 accountingAssets;
    }
    
    // Events
    event BetPlaced(address user, uint256 amount, bytes data, uint256 roundId);
    event ProtocolFeeRateUpdated(uint256 newFee);
    event BurnFeeRateUpdated(uint256 newFee);
    event JackpotFeeRateUpdated(uint256 newFee);
    event ProtocolFeeRecipientUpdated(address newRecipient);
    event WithdrawalRequested(address user, uint256 amount);
    event WithdrawalProcessed(address user, uint256 amount);
    event WithdrawalSettingsUpdated(uint256 batchSize);
    event AntiSpamSettingsUpdated(uint256 maxQueueLength);
    event LiquidityOpsPerUpkeepUpdated(uint32 ops);
    /// @dev Single log when cleaning upkeep completes: settled round (fees) + new betting boundary (mirrors prior RoundCleaned + RoundStarted).
    event RoundCleaningCompleted(
        uint256 cleanedRoundId,
        uint256 newRoundId,
        uint256 boundaryTimestamp,
        Fees fees
    );
    event LiquidityEscrowSet(address escrow);
    event QueuedLiquidityRejected(address payer, uint256 assets, uint8 reason);
    event WithdrawalEjected(address user, uint8 reason);
    /// @dev Emitted when Roulette signals the betting window has closed (pre-VRF); `roundId` is {StakedBRB} `currentRound` at that moment.
    event BettingWindowClosed(uint256 roundId);
    
    // Errors
    error OnlyBRB();
    error OnlyRoulette();
    error ZeroAmount();
    error InvalidFeeRate();
    error DepositTooSmall();
    error WithdrawalTooSmall();
    error DepositBlockedDuringResolution();
    error WithdrawalBlockedDuringResolution();
    error CancelWithdrawalBlockedDuringResolution();
    error WithdrawalPending();
    error NoWithdrawalPending();
    error WithdrawalTooLarge();
    error UnauthorizedCaller();
    error InvalidWithdrawalBatchSize();
    error QueueFull();
    error InvalidMaxQueueLength();
    error InvalidLiquidityOpsPerUpkeep();
    error OnlyCleaningForwarders();
    error DepositOutsideGamePeriod();
    error BettingClosed();
    error LiquidityEscrowAlreadySet();
    error InvalidLiquidityEscrow();
    error InvalidReceiver();
    error DepositIntentAlreadyQueued();
    
    modifier onlyBRB() {
        if (msg.sender != BRB_TOKEN) revert OnlyBRB();
        _;
    }
    
    modifier onlyRoulette() {
        if (msg.sender != ROULETTE_CONTRACT) revert OnlyRoulette();
        _;
    }
    
    modifier noPendingWithdrawal(address owner) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.pendingWithdrawal[owner].kind != 0) {
            revert WithdrawalPending();
        }
        _;
    }
    
    modifier onlyCleaningForwarders() {
        if (!IBRBUpkeepManager(UPKEEP_MANAGER).isStakedBrbCleaningForwarder(msg.sender)) revert OnlyCleaningForwarders();
        _;
    }

    function _getStakedBRBStorage() private pure returns (StakedBRBStorage storage storageStruct) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            storageStruct.slot := slot
        }
    }
    
    constructor(
        address brbToken,
        address rouletteContract,
        IERC20Mintable brbReferal,
        address jackpotContract,
        address upkeepManager
    ) {
        if (upkeepManager == address(0)) revert ZeroAmount();
        BRB_TOKEN = brbToken;
        ROULETTE_CONTRACT = rouletteContract;
        BRB_REFERRAL = brbReferal;
        JACKPOT_CONTRACT = jackpotContract;
        UPKEEP_MANAGER = upkeepManager;
        _disableInitializers();
    }
    
    function initialize(
        address admin,
        uint256 protocolFeeBasisPoints,
        uint256 burnBasisPoints,
        uint256 jackpotBasisPoints,
        address feeRecipient
    ) external initializer {
        __ERC4626_init(IERC20(BRB_TOKEN));
        __ERC20_init('Staked BRB', 'sBRB');
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        
        if (protocolFeeBasisPoints > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeRate();
        if (jackpotBasisPoints > MAX_JACKPOT_FEE_BPS) revert InvalidFeeRate();
        if (burnBasisPoints > MAX_BURN_FEE_BPS) revert InvalidFeeRate();
        if (protocolFeeBasisPoints + burnBasisPoints + jackpotBasisPoints > MAX_TOTAL_FEE_BPS) revert InvalidFeeRate();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.protocolFeeBasisPoints = protocolFeeBasisPoints;
        $.burnBasisPoints = burnBasisPoints;
        $.jackpotBasisPoints = jackpotBasisPoints;
        $.feeRecipient = feeRecipient;
        
        // Initialize withdrawal settings with defaults
        $.withdrawalBatchSize = DEFAULT_WITHDRAWAL_BATCH_SIZE;
        $.liquidityOpsPerCleaningUpkeep = DEFAULT_LIQUIDITY_OPS_PER_UPKEEP;

        // Initialize anti-spam protection
        $.maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH;
        
        $.currentRound = 1;
        $.lastRoundResolved = 0; // Initialize to 0, will be updated when rounds are processed
        $.lastRoundPaid = 0; // Initialize to 0, will be updated when rounds are completed
        $.lastRoundBoundaryTimestamp = block.timestamp;
        $.roundResolutionLocked = false;
        $.roundTransitionInProgress = false; // Initialize to false, no transition in progress initially
        emit ProtocolFeeRecipientUpdated(feeRecipient);
        emit ProtocolFeeRateUpdated(protocolFeeBasisPoints);
    }
    
    /**
     * @dev Returns total assets available to stakers (excludes pending bets)
     * @dev This prevents manipulation from unresolved betting amounts
     */
    function totalAssets() public view override returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 totalBalance = IERC20(asset()).balanceOf(address(this));

        // Queued deposit BRB lives in liquidityEscrow, not in the vault balance.
        return totalBalance - $.pendingBets;
    }

    /**
     * @dev One-time wiring of the liquidity escrow used for queued deposits (must match deployed {StakedBRBLiquidityEscrow}).
     */
    function setLiquidityEscrow(address escrow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (escrow == address(0)) revert ZeroAmount();
        if (escrow.code.length == 0) revert InvalidLiquidityEscrow();
        if ($.liquidityEscrow != address(0)) revert LiquidityEscrowAlreadySet();
        $.liquidityEscrow = escrow;
        emit LiquidityEscrowSet(escrow);
    }

    /**
     * @dev Handle BRB token transfers for betting (ERC677 callback)
     * @param from Address that sent the tokens
     * @param amount Amount of tokens sent
     * @param data Additional data for the bet
     */
    function onTokenTransfer(address from, uint256 amount, bytes calldata data, address referral) external onlyBRB nonReentrant {
        if (!IRoulette(ROULETTE_CONTRACT).isBettingOpen()) revert BettingClosed();
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 currentRound = $.currentRound;
        // Track as pending bet (excluded from totalAssets until resolved)
        $.pendingBets += amount;
                
        // Forward the bet to the roulette contract (no longer needs our address as parameter)
        uint256 maxPayout = IRoulette(ROULETTE_CONTRACT).bet(from, amount, data);
        uint256 nextMaxPayout = $.maxPayout + maxPayout;

        $.maxPayout = nextMaxPayout;
        
        emit BetPlaced(from, amount, data, currentRound);

        require(IERC20(BRB_TOKEN).balanceOf(address(this)) >= nextMaxPayout, InsufficientBalanceForMaxPayout());
        if (referral != address(0)) {
            BRB_REFERRAL.mint(referral, amount);
        }
    }
    
    /**
     * @dev Chainlink Automation `checkUpkeep` (registered upkeep contract is this vault, like {RouletteClean}).
     * @param checkData Empty for full cleaning (fees + withdrawals)
     *
     * SEQUENTIAL SAFETY: This function ensures proper order of operations:
     * 1. First process protocol fees when rounds have profit
     * 2. Then process queued withdrawals in batches
     *
     * MAXIMIZE COMPUTATIONS: All logic computed here since checkUpkeep is free to read
     *
     * Upkeep runs only when a resolved round is waiting to be cleaned (`lastRoundPaid > lastRoundResolved`).
     * Same `performUpkeep` applies fees, bounded withdrawals, and bounded liquidity; any remainder is
     * finished on the next round cleaning.
     */
    function checkUpkeep(bytes calldata checkData) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (checkData.length == 0) {
            StakedBRBStorage storage $ = _getStakedBRBStorage();
            if ($.lastRoundPaid > $.lastRoundResolved) {
                uint256 queueSize = $.queueSize;
                 // Check if we need to process protocol fees AND queued withdrawals
                CheckUpkeepVars memory v = CheckUpkeepVars({
                    roundToProcess: $.lastRoundResolved + 1,
                    actualProcessCount: 0,
                    batchSize: $.withdrawalBatchSize,
                    hasWithdrawals: queueSize > 0,
                    queueLength: 0
                });

                // Calculate protocol fees for this round: pendingBets - totalPayouts
                uint256 roundPendingBets = $.pendingBets;
                uint256 roundTotalPayouts = $.totalPayouts;
                uint256 roundNetLoss = roundPendingBets > roundTotalPayouts ? roundPendingBets - roundTotalPayouts : 0;

                // Pre-compute all withdrawal data for performUpkeep
                uint256 withdrawalsToProcess = queueSize > v.batchSize ? v.batchSize : queueSize;

                // Pre-compute which users and amounts to process
                address[] memory usersToProcess = new address[](withdrawalsToProcess);
                uint256[] memory amountsToProcess = new uint256[](withdrawalsToProcess);


                if (v.hasWithdrawals) {
                    v.queueLength = $.withdrawalQueue.length;
                    uint256 currentIndex = $.queueHead;
                    uint256 maxIterations = queueSize;
                    uint256 safeCapacity = _calculateSafeWithdrawalCapacity();

                    address user;
                    uint256 amount;
                    for (uint256 i; i < withdrawalsToProcess && maxIterations > 0;) {
                        if (currentIndex >= v.queueLength) break;

                        user = $.withdrawalQueue[currentIndex];
                        if (user != address(0)) {
                            QueuedWithdrawal storage pw = $.pendingWithdrawal[user];
                            amount = pw.kind == 1 ? pw.assets : (pw.kind == 2 ? previewRedeem(pw.shares) : 0);

                            // Only include users that can be safely processed
                            if (amount > 0 && safeCapacity >= amount) {
                                usersToProcess[v.actualProcessCount] = user;
                                amountsToProcess[v.actualProcessCount] = amount;
                                v.actualProcessCount++;
                            }
                        }
                        currentIndex++;
                        i++;
                        maxIterations--;
                    }
                }

                upkeepNeeded = true;
                performData = abi.encode(CleaningUpkeepData({
                    roundId: v.roundToProcess,
                    fees: _calculateProtocolFee(roundNetLoss),
                    hasWithdrawals: v.hasWithdrawals,
                    usersToProcess: usersToProcess,
                    amountsToProcess: amountsToProcess,
                    actualProcessCount: v.actualProcessCount
                }));
            }
        }
    }

    /**
     * @dev Chainlink Automation `performUpkeep`; only the registry forwarder for the cleaning upkeep may call.
     */
    function performUpkeep(bytes calldata performData) external override onlyCleaningForwarders nonReentrant {
        _processCleaning(abi.decode(performData, (CleaningUpkeepData)));
    }

    /// @dev Queued liquidity: assets moved in via escrow; `_mint` alone only emits `Transfer` — IERC4626 expects `Deposit`.
    function _mintAndEmitDeposit(address payer, address receiver, uint256 assets, uint256 shares) private {
        _mint(receiver, shares);
        emit Deposit(payer, receiver, assets, shares);
    }

    /**
     * @dev Process cleaning operations: protocol fees and/or queued withdrawals
     */
    function _processCleaning(CleaningUpkeepData memory cleaningData) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();

        // Sanity check: fees cannot exceed net loss (defense-in-depth)
        {
            uint256 totalFees = cleaningData.fees.protocolFees + cleaningData.fees.burnAmount + cleaningData.fees.jackpotAmount;
            uint256 netLoss = $.pendingBets > $.totalPayouts ? $.pendingBets - $.totalPayouts : 0;
            require(totalFees <= netLoss, "fees exceed net loss");
        }

        uint256 processWithdrawals = cleaningData.actualProcessCount;
        if (processWithdrawals > $.withdrawalBatchSize) {
            processWithdrawals = $.withdrawalBatchSize;
        }
        uint256 usersLen = cleaningData.usersToProcess.length;
        if (processWithdrawals > usersLen) {
            processWithdrawals = usersLen;
        }

        // Sequential round: outstanding max payout applies only to the closed round; clear before new betting.
        $.maxPayout = 0;
        $.totalPayouts = 0;
        $.pendingBets = 0;

        $.lastRoundResolved = cleaningData.roundId;
        if (cleaningData.fees.protocolFees > 0) {
            IERC20(BRB_TOKEN).transfer($.feeRecipient, cleaningData.fees.protocolFees);
        }
        if (cleaningData.fees.jackpotAmount > 0) {
            IERC20(BRB_TOKEN).transfer(JACKPOT_CONTRACT, cleaningData.fees.jackpotAmount);
        }
        if (cleaningData.fees.burnAmount > 0) {
            IERC20Burnable(BRB_TOKEN).burn(cleaningData.fees.burnAmount);
        }
        if (cleaningData.hasWithdrawals && processWithdrawals > 0) {
            address user;
            for (uint256 i; i < processWithdrawals;) {
                user = cleaningData.usersToProcess[i];
                if (user != address(0)) {
                    _finalizeWithdrawal(user);
                }
                unchecked {
                    ++i;
                }
            }
        }

        {
            uint256 head = $.depositMintQueueHead;
            uint256 len = $.depositMintQueue.length;
            if (head < len) {
                uint256 maxOps = uint256($.liquidityOpsPerCleaningUpkeep);
                if (maxOps != 0) {
                    StakedBRBLiquidityEscrow escrow = StakedBRBLiquidityEscrow($.liquidityEscrow);
                    uint256 processed;
                    uint256 idx;
                    QueuedLiquidity storage ql;
                    uint256 sharesOut;
                    uint256 need;
                    while (head < len && processed < maxOps) {
                        idx = head;
                        ql = $.depositMintQueue[idx];
                        $.queuedDepositIntentByPayer[ql.payer] = false;
                        if (ql.kind == 0) {
                            sharesOut = previewDeposit(ql.assets);
                            if (sharesOut < ql.minSharesOut) {
                                escrow.refund(ql.payer, ql.assets);
                                emit QueuedLiquidityRejected(ql.payer, ql.assets, 0);
                            } else {
                                escrow.pushToVault(ql.assets);
                                _mintAndEmitDeposit(ql.payer, ql.receiver, ql.assets, sharesOut);
                            }
                        } else {
                            need = previewMint(ql.shares);
                            if (need > ql.assets) {
                                escrow.refund(ql.payer, ql.assets);
                                emit QueuedLiquidityRejected(ql.payer, ql.assets, 1);
                            } else {
                                escrow.pushToVault(need);
                                if (ql.assets > need) {
                                    escrow.refund(ql.payer, ql.assets - need);
                                }
                                _mintAndEmitDeposit(ql.payer, ql.receiver, need, ql.shares);
                            }
                        }
                        unchecked {
                            ++head;
                            ++processed;
                        }
                        delete $.depositMintQueue[idx];
                    }
                    $.depositMintQueueHead = head;
                    if (head == $.depositMintQueue.length && head > 0) {
                        delete $.depositMintQueue;
                        $.depositMintQueueHead = 0;
                    }
                }
            }
        }

        $.lastRoundBoundaryTimestamp = block.timestamp;
        IRoulette(ROULETTE_CONTRACT).onRoundBoundary($.lastRoundBoundaryTimestamp);

        $.roundTransitionInProgress = false;

        emit RoundCleaningCompleted(
            cleaningData.roundId,
            $.currentRound,
            $.lastRoundBoundaryTimestamp,
            cleaningData.fees
        );
    }

    /**
     * @dev Process roulette results - called by Roulette contract (BATCH PROCESSING)
     * @dev Implements final-batch profit recognition to prevent double reduction and timing attacks
     * @param payouts Array of payout info for multiple winners/losers
     */
    function processRouletteResult(uint256 roundId, IRoulette.PayoutInfo[] memory payouts, uint256 totalPayouts, bool isLastBatch) external onlyRoulette nonReentrant {
        StakedBRBStorage storage $ = _getStakedBRBStorage();

        // Sanity check: cumulative payouts cannot exceed the worst-case maxPayout reserved at bet time
        require($.totalPayouts + totalPayouts <= $.maxPayout, "payouts exceed maxPayout");

        // If this is the last batch, track pending bets for this round
        if (isLastBatch) {
            // Store pending bets for this round (for fee calculation)
            // Reduce total pending bets by the amount for this round
            // This correctly reflects the assets available to stakers after round resolution
            
            // Update lastRoundPaid to track completed rounds
            $.lastRoundPaid = roundId;

            if (totalPayouts == 0) return;
            
            // NOTE: Withdrawals remain locked until cleaning upkeep processes the withdrawal queue
            // This ensures proper order: process withdrawals first, then unlock
        }
        $.totalPayouts += totalPayouts;

        IBRB(BRB_TOKEN).transferBatch(payouts);
    }


    /**
     * @dev Called by Roulette after the betting window ends (pre-VRF upkeep) to lock resolution-side flows.
     */
    function onBettingWindowClosed() external onlyRoulette {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.roundResolutionLocked = true;
        emit BettingWindowClosed($.currentRound);
    }

    /**
     * @dev Called by Roulette when VRF is requested; advances round id and enters post-VRF transition.
     */
    function onRoundTransition(uint256 newRoundId) external onlyRoulette {
        StakedBRBStorage storage $ = _getStakedBRBStorage();

        $.roundResolutionLocked = false;
        $.roundTransitionInProgress = true;
        $.currentRound = newRoundId;
    }
    
    /// @dev Calculate the safe withdrawal capacity that won't risk payout solvency
    /// @return safeCapacity Maximum amount that can be safely withdrawn immediately
    function _calculateSafeWithdrawalCapacity() private view returns (uint256 safeCapacity) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Get current total assets and maxPayout
        uint256 currentTotalAssets = totalAssets();
        uint256 currentMaxPayout = $.maxPayout;
        
        // Safe capacity is the difference between total assets and maxPayout
        safeCapacity = currentTotalAssets > currentMaxPayout ? currentTotalAssets - currentMaxPayout : 0;
    }
    
    function _ejectWithdrawal(address user, uint256 queueIndex, uint8 reason) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        delete $.pendingWithdrawal[user];
        _removeUserFromQueueEfficient(queueIndex);
        emit WithdrawalEjected(user, reason);
    }

    /// @dev Settles one queued withdrawal at the current exchange rate or ejects on slippage / balance checks.
    function _finalizeWithdrawal(address user) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        QueuedWithdrawal memory q = $.pendingWithdrawal[user];
        uint256 queueIndex = $.userQueuePosition[user];

        if (q.kind == 1) {
            uint256 sh = super.previewWithdraw(q.assets);
            if (sh > q.maxShares) {
                _ejectWithdrawal(user, queueIndex, 1);
                return;
            }
            if (sh > balanceOf(user)) {
                _ejectWithdrawal(user, queueIndex, 3);
                return;
            }
            super.withdraw(q.assets, q.receiver, user, q.maxShares);
            emit WithdrawalProcessed(user, q.assets);
        } else if (q.kind == 2) {
            uint256 aOut = super.previewRedeem(q.shares);
            if (aOut < q.minAssets) {
                _ejectWithdrawal(user, queueIndex, 2);
                return;
            }
            if (q.shares > balanceOf(user)) {
                _ejectWithdrawal(user, queueIndex, 3);
                return;
            }
            super.redeem(q.shares, q.receiver, user, q.minAssets);
            emit WithdrawalProcessed(user, aOut);
        } else {
            return;
        }

        delete $.pendingWithdrawal[user];
        _removeUserFromQueueEfficient(queueIndex);
    }
    
    /// @dev Remove user from queue efficiently using dynamic array
    function _removeUserFromQueueEfficient(uint256 index) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        require(index < $.withdrawalQueue.length, IndexOutOfBounds());
        require($.queueSize > 0, QueueIsEmpty());
        
        // Get the user being removed
        address userToRemove = $.withdrawalQueue[index];
        
        // Clear user's queue position and pending withdrawal
        $.userQueuePosition[userToRemove] = 0;
        
        // Mark slot as empty (we'll reuse it)
        $.withdrawalQueue[index] = address(0);
        
        // Decrease queue size
        $.queueSize--;
        
        // If queue is now empty, reset pointers
        if ($.queueSize == 0) {
            $.queueHead = 0;
            $.queueTail = 0;
            delete $.withdrawalQueue;
        }
    }
    
    /**
     * @dev Calculate protocol fee from betting loss using OpenZeppelin's math
     * @param lossAmount Amount lost by player
     * @return fee Amount that goes to protocol
     */
    function _calculateProtocolFee(uint256 lossAmount) private view returns (Fees memory fee) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (lossAmount == 0) return (fee);

        fee.jackpotAmount = lossAmount.mulDiv(
            $.jackpotBasisPoints, 
            _BASIS_POINT_SCALE, 
            Math.Rounding.Floor  // Round down
        );
        // Use OpenZeppelin's mulDiv for precise fee calculation
        fee.protocolFees = lossAmount.mulDiv(
            $.protocolFeeBasisPoints, 
            _BASIS_POINT_SCALE, 
            Math.Rounding.Floor  // Round down
        );
        fee.burnAmount = lossAmount.mulDiv(
            $.burnBasisPoints, 
            _BASIS_POINT_SCALE, 
            Math.Rounding.Floor  // Round down
        );

    }
    
    // === Protocol Fees Management ===
    
    /**
     * @dev Update protocol fee rate taken from betting losses (only admin)
     * @param newFeeBasisPoints New fee rate in basis points (e.g., 250 = 2.5%)
     */
    function setProtocolFeeRate(uint256 newFeeBasisPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (newFeeBasisPoints > MAX_PROTOCOL_FEE_BPS) revert InvalidFeeRate();
        if (newFeeBasisPoints + $.burnBasisPoints + $.jackpotBasisPoints > MAX_TOTAL_FEE_BPS) revert InvalidFeeRate();

        $.protocolFeeBasisPoints = newFeeBasisPoints;

        emit ProtocolFeeRateUpdated(newFeeBasisPoints);
    }

    function setJackpotFeeRate(uint256 newJackpotBasisPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (newJackpotBasisPoints > MAX_JACKPOT_FEE_BPS) revert InvalidFeeRate();
        if (newJackpotBasisPoints + $.protocolFeeBasisPoints + $.burnBasisPoints > MAX_TOTAL_FEE_BPS) revert InvalidFeeRate();

        $.jackpotBasisPoints = newJackpotBasisPoints;

        emit JackpotFeeRateUpdated(newJackpotBasisPoints);
    }

    function setBurnFeeRate(uint256 newBurnBasisPoints) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (newBurnBasisPoints > MAX_BURN_FEE_BPS) revert InvalidFeeRate();
        if (newBurnBasisPoints + $.protocolFeeBasisPoints + $.jackpotBasisPoints > MAX_TOTAL_FEE_BPS) revert InvalidFeeRate();

        $.burnBasisPoints = newBurnBasisPoints;

        emit BurnFeeRateUpdated(newBurnBasisPoints);
    }
    /**
     * @dev Update fee recipient (only admin)
     * @param newRecipient Address that will receive withdrawn fees
     */
    function setFeeRecipient(address newRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRecipient == address(0)) revert InvalidFeeRate();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.feeRecipient = newRecipient;
        emit ProtocolFeeRecipientUpdated(newRecipient);
    }

    function depositWithPermit(uint256 assets, address receiver, uint256 minSharesOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external returns (uint256 shares) {
        try IERC20Permit(BRB_TOKEN).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        _checkDepositAllowed(assets);
        if (!_inGamePeriod()) revert DepositOutsideGamePeriod();
        if (totalSupply() == 0) {
            return super.deposit(assets, receiver, minSharesOut);
        }
        _enqueueLiquidityDeposit(assets, receiver, minSharesOut);
        shares = previewDeposit(assets);
        return shares;
    }
    /**
    * @dev Override deposit to enforce minimum deposit; queues mint during GAME_PERIOD (applied on cleaning upkeep).
    *      First deposit ever mints immediately to bootstrap the vault.
    */
    function deposit(uint256 assets, address receiver, uint256 minSharesOut) public override returns (uint256 shares) {
        _checkDepositAllowed(assets);
        if (!_inGamePeriod()) revert DepositOutsideGamePeriod();
        if (totalSupply() == 0) {
            return super.deposit(assets, receiver, minSharesOut);
        }
        _enqueueLiquidityDeposit(assets, receiver, minSharesOut);
        shares = previewDeposit(assets);
        return shares;
    }

    function mint(uint256 shares, address receiver, uint256 maxAmountIn) public override returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        uint256 assetsForMin = previewMint(shares);
        if (totalSupply() == 0 && assetsForMin < MINIMUM_FIRST_DEPOSIT) revert DepositTooSmall();
        StakedBRBStorage storage $m = _getStakedBRBStorage();
        if ($m.roundTransitionInProgress || $m.roundResolutionLocked) revert DepositBlockedDuringResolution();
        if (!_inGamePeriod()) revert DepositOutsideGamePeriod();
        if (totalSupply() == 0) {
            return super.mint(shares, receiver, maxAmountIn);
        }
        if (maxAmountIn == 0) revert ZeroAmount();
        if ($m.queuedDepositIntentByPayer[msg.sender]) revert DepositIntentAlreadyQueued();
        $m.queuedDepositIntentByPayer[msg.sender] = true;
        $m.depositMintQueue.push(
            QueuedLiquidity({ kind: 1, payer: msg.sender, receiver: receiver, assets: maxAmountIn, shares: shares, minSharesOut: 0 })
        );
        IERC20(asset()).transferFrom(msg.sender, $m.liquidityEscrow, maxAmountIn);
        return maxAmountIn;
    }

    /// @dev BRB moves to {liquidityEscrow}; conversion runs in {_processLiquidityQueue}.
    function _enqueueLiquidityDeposit(uint256 assets, address receiver, uint256 minSharesOut) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.queuedDepositIntentByPayer[msg.sender]) revert DepositIntentAlreadyQueued();
        $.queuedDepositIntentByPayer[msg.sender] = true;
        $.depositMintQueue.push(
            QueuedLiquidity({ kind: 0, payer: msg.sender, receiver: receiver, assets: assets, shares: 0, minSharesOut: minSharesOut })
        );
        IERC20(asset()).transferFrom(msg.sender, $.liquidityEscrow, assets);
    }

    // === Note: No ERC4626 Fees Overrides ===
    // We use pure ERC4626 without deposit/withdrawal fees
    // All fees come from betting losses, handled in processRouletteResult()
    
    /**
     * @dev All withdrawals are queued and settled on cleaning upkeep (one pending request per user).
     */
    function withdraw(uint256 assets, address receiver, address owner, uint256 maxSharesOut) public override noPendingWithdrawal(owner) returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (assets < MINIMUM_WITHDRAWAL) revert WithdrawalTooSmall();
        if (receiver == address(0)) revert InvalidReceiver();
        _checkWithdrawalAllowed(owner);
        if (owner != msg.sender) {
            revert UnauthorizedCaller();
        }
        {
            StakedBRBStorage storage $v = _getStakedBRBStorage();
            if ($v.queueSize >= $v.maxQueueLength) {
                revert QueueFull();
            }
            uint256 sharesNeeded = super.previewWithdraw(assets);
            if (sharesNeeded > balanceOf(msg.sender)) {
                revert WithdrawalTooLarge();
            }
        }
        _enqueueWithdrawal(
            QueuedWithdrawal({
                kind: 1,
                receiver: receiver,
                assets: assets,
                shares: 0,
                maxShares: maxSharesOut == 0 ? type(uint256).max : maxSharesOut,
                minAssets: 0,
                accountingAssets: assets
            })
        );
        return super.previewWithdraw(assets);
    }

    /// @dev All redemptions are queued and settled on cleaning upkeep (one pending request per user).
    function redeem(uint256 shares, address receiver, address owner, uint256 minAmountOut) public override noPendingWithdrawal(owner) returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert InvalidReceiver();
        _checkWithdrawalAllowed(owner);
        if (owner != msg.sender) {
            revert UnauthorizedCaller();
        }
        uint256 requestedAssets = super.previewRedeem(shares);
        if (requestedAssets < MINIMUM_WITHDRAWAL) revert WithdrawalTooSmall();
        {
            StakedBRBStorage storage $v = _getStakedBRBStorage();
            if ($v.queueSize >= $v.maxQueueLength) {
                revert QueueFull();
            }
            if (shares > balanceOf(msg.sender)) {
                revert WithdrawalTooLarge();
            }
        }
        _enqueueWithdrawal(
            QueuedWithdrawal({
                kind: 2,
                receiver: receiver,
                assets: 0,
                shares: shares,
                maxShares: 0,
                minAssets: minAmountOut,
                accountingAssets: requestedAssets
            })
        );
        return requestedAssets;
    }

    function _checkDepositAllowed(uint256 amount) private view {
        if (amount == 0) revert ZeroAmount();
        if (totalSupply() == 0 && amount < MINIMUM_FIRST_DEPOSIT) {
            revert DepositTooSmall();
        }
        // Block deposits during round transitions (from onRoundTransition to cleaning upkeep completion)
        StakedBRBStorage storage $s = _getStakedBRBStorage();
        if ($s.roundTransitionInProgress || $s.roundResolutionLocked) revert DepositBlockedDuringResolution();
    }

    function _inGamePeriod() private view returns (bool) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.roundTransitionInProgress || $.roundResolutionLocked) return false;
        uint256 gp = IRoulette(ROULETTE_CONTRACT).gamePeriod();
        return block.timestamp - $.lastRoundBoundaryTimestamp < gp;
    }
    
    /// @dev Private function to check if withdrawals are allowed
    function _checkWithdrawalAllowed(address owner) private view {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        // Block during pre-VRF lock or post-VRF transition until cleaning completes
        if ($.roundTransitionInProgress || $.roundResolutionLocked) {
            revert WithdrawalBlockedDuringResolution();
        }

        if ($.pendingWithdrawal[owner].kind != 0) {
            revert WithdrawalPending();
        }
    }

    function _enqueueWithdrawal(QueuedWithdrawal memory q) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.pendingWithdrawal[msg.sender] = q;

        uint256 queueTail = $.queueTail;
        if (queueTail >= $.withdrawalQueue.length) {
            $.withdrawalQueue.push(msg.sender);
        } else {
            $.withdrawalQueue[queueTail] = msg.sender;
        }

        $.userQueuePosition[msg.sender] = queueTail;
        $.queueTail = queueTail + 1;
        $.queueSize++;

        emit WithdrawalRequested(msg.sender, q.accountingAssets);
    }
    /**
     * @dev Update withdrawal batch size (admin only)
     * @param newBatchSize Number of withdrawals to process per round transition
     */
    function setWithdrawalBatchSize(uint256 newBatchSize) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBatchSize == 0 || newBatchSize > MAX_WITHDRAWAL_BATCH_SIZE) revert InvalidWithdrawalBatchSize();

        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.withdrawalBatchSize = newBatchSize;

        emit WithdrawalSettingsUpdated(newBatchSize);
    }

    /// @dev Updates max deposit/mint queue entries processed per cleaning upkeep `performUpkeep`.
    function setLiquidityOpsPerCleaningUpkeep(uint32 newOps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOps == 0 || newOps > MAX_LIQUIDITY_OPS_PER_UPKEEP) revert InvalidLiquidityOpsPerUpkeep();

        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.liquidityOpsPerCleaningUpkeep = newOps;

        emit LiquidityOpsPerUpkeepUpdated(newOps);
    }

    /// @notice Current cap on deposit/mint queue entries processed per cleaning `performUpkeep`.
    function getLiquidityOpsPerCleaningUpkeep() external view returns (uint32) {
        return _getStakedBRBStorage().liquidityOpsPerCleaningUpkeep;
    }

    /// @notice Hard caps on admin-tunable operational parameters (stay within `CLEANING_UPKEEP_GAS_LIMIT` budget).
    function getOperationalLimits() external pure returns (
        uint256 maxWithdrawalBatchSize,
        uint256 maxQueueLength,
        uint32 maxLiquidityOpsPerCleaningUpkeep,
        uint32 cleaningUpkeepGasLimit
    ) {
        return (
            MAX_WITHDRAWAL_BATCH_SIZE,
            MAX_MAX_QUEUE_LENGTH,
            MAX_LIQUIDITY_OPS_PER_UPKEEP,
            CLEANING_UPKEEP_GAS_LIMIT
        );
    }

    
    /**
     * @dev Update maximum queue length (admin only)
     * @param newMaxQueueLength New maximum number of users allowed in queue
     */
    function setMaxQueueLength(uint256 newMaxQueueLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxQueueLength == 0 || newMaxQueueLength > MAX_MAX_QUEUE_LENGTH) revert InvalidMaxQueueLength();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.maxQueueLength = newMaxQueueLength;
        
        emit AntiSpamSettingsUpdated(newMaxQueueLength);
    }
    
    /**
     * @dev Get vault configuration
     */
    function getVaultConfig() external view returns (
        address brbToken,
        address rouletteContract,
        uint256 protocolFeeBasisPoints,
        uint256 burnBasisPoints,
        uint256 jackpotBasisPoints,
        address feeRecipient,
        uint256 pendingBets
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return (
            BRB_TOKEN,
            ROULETTE_CONTRACT,
            $.protocolFeeBasisPoints,
            $.burnBasisPoints,
            $.jackpotBasisPoints,
            $.feeRecipient,
            $.pendingBets
        );
    }
    
    function getSafeCapacity() external view returns (uint256) {
        return _calculateSafeWithdrawalCapacity();
    }
    
    /**
     * @dev Preview protocol fee for a given loss amount
     * @param lossAmount Amount that would be lost in betting
     * @return fee Amount that would go to protocol
     * @return stakerProfit Amount that would go to stakers
     */
    function previewProtocolFee(uint256 lossAmount) external view returns (Fees memory fee, uint256 stakerProfit) {
        fee = _calculateProtocolFee(lossAmount);
        stakerProfit = lossAmount - (fee.protocolFees + fee.burnAmount + fee.jackpotAmount);
    }
    
    /**
     * @dev Get current pending bets amount (excluded from totalAssets)
     */
    function getPendingBets() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.pendingBets;
    }

    /**
     * @dev Get current maxPayout (cumulative max payout for active round)
     */
    function getMaxPayout() external view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return $.maxPayout;
    }

    /**
     * @dev Get withdrawal settings and status (total pending liability is off-chain via events / subgraph).
     * @return withdrawalBatchSize Current batch size for processing
     * @return queueLength Current length of withdrawal queue
     * @return maxQueueLength Maximum allowed queue length
     */
    function getWithdrawalSettings() external view returns (
        uint256 withdrawalBatchSize,
        uint256 queueLength,
        uint256 maxQueueLength
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        withdrawalBatchSize = $.withdrawalBatchSize;
        queueLength = $.queueSize;
        maxQueueLength = $.maxQueueLength;
    }
    
    /**
     * @dev Get user's pending queued withdrawal information
     * @param user Address to check
     * @return pendingAmount Amount pending for withdrawal
     * @return queuePosition Position in withdrawal queue (0 = not in queue)
     */
    function getUserPendingWithdrawal(address user) external view returns (
        uint256 pendingAmount,
        uint256 queuePosition
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        QueuedWithdrawal storage q = $.pendingWithdrawal[user];
        if (q.kind == 0) {
            return (0, 0);
        }
        pendingAmount = q.kind == 1 ? q.assets : previewRedeem(q.shares);
        uint256 queueIndex = $.userQueuePosition[user];
        uint256 position;
        uint256 currentIndex = $.queueHead;
        uint256 maxIterations = $.queueSize;
        while (currentIndex != queueIndex && maxIterations > 0) {
            if (currentIndex >= $.withdrawalQueue.length) {
                break;
            }
            if ($.withdrawalQueue[currentIndex] != address(0)) {
                position++;
            }
            currentIndex = currentIndex + 1;
            maxIterations--;
        }
        queuePosition = currentIndex == queueIndex ? position + 1 : 0;
    }
    
    /// @dev Cancel the caller's single pending queued withdrawal (if any).
    function cancelWithdrawal() external {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        if ($.roundTransitionInProgress || $.roundResolutionLocked) revert CancelWithdrawalBlockedDuringResolution();
        QueuedWithdrawal memory q = $.pendingWithdrawal[msg.sender];
        if (q.kind == 0) revert NoWithdrawalPending();

        uint256 queueIndex = $.userQueuePosition[msg.sender];
        if (queueIndex >= $.withdrawalQueue.length || $.withdrawalQueue[queueIndex] != msg.sender) {
            revert UserNotInQueue();
        }

        _removeUserFromQueueEfficient(queueIndex);
        delete $.pendingWithdrawal[msg.sender];

        uint256 emitAmount = q.kind == 1 ? q.assets : previewRedeem(q.shares);
        emit WithdrawalProcessed(msg.sender, emitAmount);
    }

    function lastRoundBoundaryTimestamp() external view returns (uint256) {
        return _getStakedBRBStorage().lastRoundBoundaryTimestamp;
    }

    function roundTransitionInProgress() external view returns (bool) {
        return _getStakedBRBStorage().roundTransitionInProgress;
    }

    function roundResolutionLocked() external view returns (bool) {
        return _getStakedBRBStorage().roundResolutionLocked;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
