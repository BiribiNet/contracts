// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC4626Upgradeable } from "./external/ERC4626Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { RouletteClean } from "./RouletteClean.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";
import { IAutomationRegistrar2_1 } from "./interfaces/IAutomationRegistrar2_1.sol";
import { IAutomationRegistry2_1 } from "./interfaces/IAutomationRegistry2_1.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
/**
 * @title StakedBRB Unified
 * @dev ERC4626 vault with built-in roulette betting and protocol fees
 * @dev Uses OpenZeppelin's ERC4626Fees pattern for clean fee handling
 * @dev Handles staking, betting, protocol fees, and roulette integration
 */
contract StakedBRB is ERC4626Upgradeable, AccessControlUpgradeable, UUPSUpgradeable, AutomationCompatibleInterface {
    using Math for uint256;
        
    // Immutable addresses for gas optimization
    address private immutable BRB_TOKEN;
    address private immutable ROULETTE_CONTRACT;
    
    // Security constants
    uint256 public constant MINIMUM_FIRST_DEPOSIT = 1000;
    uint256 public constant MAX_PROTOCOL_FEE = 10000; // 100% max
    uint256 private constant _BASIS_POINT_SCALE = 1e4;
    
    // Withdrawal constants
    uint256 public constant DEFAULT_LARGE_WITHDRAWAL_BATCH_SIZE = 5; // Process 5 withdrawals per round transition
    uint256 public constant MAX_LARGE_WITHDRAWAL_BATCH_SIZE = 20;   // Max 20 per round
    
    // Anti-spam constants
    uint256 public constant DEFAULT_MAX_QUEUE_LENGTH = 100;           // Max 100 users in queue
    uint256 public constant MAX_MAX_QUEUE_LENGTH = 1000;             // Max 1000 users in queue
    
    // Storage location for upgradeable pattern
    bytes32 private constant STORAGE_LOCATION = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd00;
    
    // Chainlink Automation constants
    uint32 private constant CLEANING_UPKEEP_GAS_LIMIT = 500000; // Gas limit for cleaning upkeep

    error InsufficientBalanceForMaxPayout();
    error IndexOutOfBounds();
    error QueueIsEmpty();
    error UserNotInQueue();
    struct StakedBRBStorage {
        uint256 protocolFeeBasisPoints;  // Protocol fee taken from betting losses (e.g. 250 = 2.5%)
        address feeRecipient;            // Where protocol fees go
        uint256 pendingBets;             // BRB amount in unresolved bets (excluded from totalAssets)
        uint256 maxPayout;               // Maximum payout for current round
        uint256 currentRound;            // Current active round for betting
        uint256 lastRoundPaid;           // Last round that was fully processed (for tracking active rounds)
        uint256 lastRoundResolved;       // Last round that was resolved (for tracking active rounds)
        bool roundTransitionInProgress;  // True when round transition has started but not completed
        mapping(uint256 => uint256) totalPayouts; // Round => total payouts for that round
        mapping(uint256 => uint256) totalWinningBets; // Round => total winning bets for that round
        mapping(uint256 => bool) totalWinningBetsSet; // Round => total winning bets set
        mapping(uint256 => uint256) pendingBetsPerRound; // Round => pending bets for that round
        
        // Withdrawal management
        uint256 largeWithdrawalBatchSize; // Number of withdrawals to process per round transition
        
        // Large withdrawal queue - Gas efficient implementation
        address[] largeWithdrawalQueue; // Dynamic array of users
        mapping(address => uint256) pendingLargeWithdrawals; // User => withdrawal amount pending
        mapping(address => uint256) userQueuePosition; // User => their position in queue (O(1) access)
        uint256 queueHead; // Index of first user in queue
        uint256 queueTail; // Index of next free slot
        uint256 queueSize; // Number of users currently in queue
        uint256 totalPendingLargeWithdrawals; // Total amount of pending large withdrawals
        
        // Anti-spam protection
        uint256 maxQueueLength; // Maximum number of users allowed in queue
        
        // Chainlink Automation setup
        mapping(address => uint256) forwarders; // forwarder => upkeepId
        address keeperRegistrar;
        address keeperRegistry;
        address linkToken;
    }
    
    struct CheckUpkeepVars {
        uint256 roundToProcess;
        uint256 actualProcessCount;
        uint256 batchSize;
        bool hasWithdrawals;
        uint256 queueLength;
    }

    struct CleaningUpkeepData {
        uint256 roundId;
        uint256 totalFees;
        bool hasWithdrawals; // Whether to also process large withdrawals
        address[] usersToProcess; // Pre-computed users to process for withdrawals
        uint256[] amountsToProcess; // Pre-computed amounts for each user
        uint256 actualProcessCount; // Actual number of users to process
    }
    
    // Events
    event BetPlaced(address user, uint256 amount, bytes data);
    event BetResult(address player, uint256 betAmount, uint256 protocolFee, uint256 stakerProfit, bool isWin);
    event ProfitDistributed(uint256 amount);
    event ProtocolFeeCollected(uint256 amount);
    event ProtocolFeeRateUpdated(uint256 oldFee, uint256 newFee);
    event FeeWithdrawn(uint256 amount, address recipient);
    event LargeWithdrawalRequested(address user, uint256 amount);
    event LargeWithdrawalProcessed(address user, uint256 amount);
    event WithdrawalSettingsUpdated(uint256 batchSize);
    event AntiSpamSettingsUpdated(uint256 maxQueueLength);
    event RoundTransition(uint256 previousRound, uint256 newRound);
    event CleaningUpkeepRegistered(uint256 indexed upkeepId, address indexed forwarder, uint32 gasLimit, uint96 linkAmount, string upkeepType);
    
    // Errors
    error OnlyBRB();
    error OnlyRoulette();
    error ZeroAmount();
    error InvalidFeeRate();
    error InsufficientBalance();
    error TransferFailed();
    error DepositTooSmall();
    error AmountExceedsTotalAssets();
    error ExceedsSafeBettingLimit();
    error DepositBlockedDuringResolution();
    error WithdrawalBlockedDuringResolution();
    error LargeWithdrawalPending();
    error InvalidWithdrawalFee();
    error WithdrawalTooLarge();
    error UnauthorizedCaller();
    error InvalidRoundProgression();
    error InvalidWithdrawalBatchSize();
    error QueueFull();
    error InvalidMaxQueueLength();
    error OnlyForwarders();
    error UpkeepRegistrationFailed();
    
    modifier onlyBRB() {
        if (msg.sender != BRB_TOKEN) revert OnlyBRB();
        _;
    }
    
    modifier onlyRoulette() {
        if (msg.sender != ROULETTE_CONTRACT) revert OnlyRoulette();
        _;
    }
    
    modifier noPendingLargeWithdrawal(address owner) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.pendingLargeWithdrawals[owner] > 0) {
            revert LargeWithdrawalPending();
        }
        _;
    }
    
    /**
     * @dev Only allows calls from registered Chainlink forwarders
     */
    modifier onlyForwarders() {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.forwarders[msg.sender] == 0) revert OnlyForwarders();
        _;
    }
    
    function _getStakedBRBStorage() private pure returns (StakedBRBStorage storage storageStruct) {
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
        
        // Initialize withdrawal settings with defaults
        $.largeWithdrawalBatchSize = DEFAULT_LARGE_WITHDRAWAL_BATCH_SIZE;
        
        // Initialize anti-spam protection
        $.maxQueueLength = DEFAULT_MAX_QUEUE_LENGTH;
        
        $.currentRound = 1;
        $.lastRoundResolved = 0; // Initialize to 0, will be updated when rounds are processed
        $.lastRoundPaid = 0; // Initialize to 0, will be updated when rounds are completed
        $.roundTransitionInProgress = false; // Initialize to false, no transition in progress initially
    }
    
    /**
     * @dev Returns total assets available to stakers (excludes pending bets)
     * @dev This prevents manipulation from unresolved betting amounts
     */
    function totalAssets() public view override returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 totalBalance = IERC20(asset()).balanceOf(address(this));

        return totalBalance - $.pendingBets; // Directly subtract pendingBets
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
     * @dev Setup Chainlink Automation addresses (admin only)
     * @param keeperRegistrar Address of the keeper registrar
     * @param keeperRegistry Address of the keeper registry
     * @param linkToken Address of the LINK token
     */
    function setupChainlink(
        address keeperRegistrar,
        address keeperRegistry,
        address linkToken
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (keeperRegistrar == address(0) || keeperRegistry == address(0) || linkToken == address(0)) {
            revert ZeroAmount();
        }
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.keeperRegistrar = keeperRegistrar;
        $.keeperRegistry = keeperRegistry;
        $.linkToken = linkToken;
        
        // Approve LINK for upkeep registration
        IERC20(linkToken).approve(keeperRegistrar, type(uint256).max);
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
        
        // Track pending bets for current round
        $.pendingBetsPerRound[$.currentRound] += amount;
        
        // Forward the bet to the roulette contract (no longer needs our address as parameter)
        uint256 maxPayout = RouletteClean(ROULETTE_CONTRACT).bet(from, amount, data);
        uint256 nextMaxPayout = $.maxPayout + maxPayout;
        $.maxPayout = nextMaxPayout;  // Fixed: should be nextMaxPayout, not maxPayout
        
        emit BetPlaced(from, amount, data);

        require(IERC20(BRB_TOKEN).balanceOf(address(this)) >= nextMaxPayout, InsufficientBalanceForMaxPayout());
    }
    
    /**
     * @dev Chainlink Automation: Check if cleaning upkeep needed
     * @param checkData Empty for full cleaning (fees + withdrawals)
     * 
     * SEQUENTIAL SAFETY: This function ensures proper order of operations:
     * 1. First process protocol fees when rounds have profit
     * 2. Then process large withdrawals in batches
     * 
     * MAXIMIZE COMPUTATIONS: All logic computed here since checkUpkeep is free to read
     */
    function checkUpkeep(bytes calldata checkData) external view override returns (bool upkeepNeeded, bytes memory performData) {
        // Always trigger upkeep if there are fees OR withdrawals OR if any round has been completed
        if (checkData.length == 0) {
            StakedBRBStorage storage $ = _getStakedBRBStorage();
            if ($.lastRoundPaid > $.lastRoundResolved) {
                 // Check if we need to process protocol fees AND large withdrawals
                uint256 queueSize = $.queueSize;
                CheckUpkeepVars memory v = CheckUpkeepVars({
                    roundToProcess: $.lastRoundResolved + 1,
                    actualProcessCount: 0,
                    batchSize: $.largeWithdrawalBatchSize,
                    hasWithdrawals: queueSize > 0,
                    queueLength: 0
                });

                // Calculate protocol fees for this round: pendingBets - totalPayouts
                uint256 roundPendingBets = $.pendingBetsPerRound[v.roundToProcess];
                uint256 roundTotalPayouts = $.totalPayouts[v.roundToProcess];
                uint256 roundNetLoss = roundPendingBets > roundTotalPayouts ? roundPendingBets - roundTotalPayouts : 0;
                uint256 roundProtocolFees = _calculateProtocolFee(roundNetLoss);

                // Pre-compute all withdrawal data for performUpkeep
                uint256 withdrawalsToProcess = queueSize > v.batchSize ? v.batchSize : queueSize;

                // Pre-compute which users and amounts to process
                address[] memory usersToProcess = new address[](withdrawalsToProcess);
                uint256[] memory amountsToProcess = new uint256[](withdrawalsToProcess);


                if (v.hasWithdrawals) {
                    v.queueLength = $.largeWithdrawalQueue.length;
                    uint256 currentIndex = $.queueHead;
                    uint256 maxIterations = queueSize;
                    uint256 safeCapacity = _calculateSafeWithdrawalCapacity();

                    address user;
                    uint256 amount;
                    for (uint256 i; i < withdrawalsToProcess && maxIterations > 0;) {
                        if (currentIndex >= v.queueLength) break;

                        user = $.largeWithdrawalQueue[currentIndex];
                        if (user != address(0)) {
                            amount = $.pendingLargeWithdrawals[user];

                            // Only include users that can be safely processed
                            if (safeCapacity >= amount) {
                                usersToProcess[v.actualProcessCount] = user;
                                amountsToProcess[v.actualProcessCount] = amount;
                                v.actualProcessCount++;
                            }
                        }
                        currentIndex++;
                        maxIterations--;
                    }
                }

                upkeepNeeded = true;
                performData = abi.encode(CleaningUpkeepData({
                    roundId: v.roundToProcess,
                    totalFees: roundProtocolFees,
                    hasWithdrawals: v.hasWithdrawals,
                    usersToProcess: usersToProcess,
                    amountsToProcess: amountsToProcess,
                    actualProcessCount: v.actualProcessCount
                }));
            }
        }
    }

    /**
     * @dev Chainlink Automation: Perform cleaning upkeep
     */
    function performUpkeep(bytes calldata performData) external override onlyForwarders {
        CleaningUpkeepData memory payload = abi.decode(performData, (CleaningUpkeepData));
        _processCleaning(payload);
    }
    /**
     * @dev Process cleaning operations: protocol fees and/or large withdrawals
     */
    function _processCleaning(CleaningUpkeepData memory cleaningData) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // 1. PROCESS PROTOCOL FEES (if any)
        if (cleaningData.totalFees > 0) {
            // Transfer protocol fees to fee recipient
            IERC20(BRB_TOKEN).transfer($.feeRecipient, cleaningData.totalFees);
            emit ProtocolFeeCollected(cleaningData.totalFees);
        }
        
        // 2. PROCESS LARGE WITHDRAWALS (if needed)
        if (cleaningData.hasWithdrawals) {
            _processLargeWithdrawalBatchPreComputed(cleaningData.usersToProcess, cleaningData.amountsToProcess, cleaningData.actualProcessCount);
        }

        $.maxPayout = 0;
        // 3. UPDATE lastRoundResolved to mark this round as processed
        $.lastRoundResolved = cleaningData.roundId;
        
        // 4. CLEAR round transition flag - deposits/withdrawals are now allowed again
        $.roundTransitionInProgress = false;
    }
    

    
    /**
     * @dev Process roulette results - called by Roulette contract (BATCH PROCESSING)
     * @dev Implements final-batch profit recognition to prevent double reduction and timing attacks
     * @param payouts Array of payout info for multiple winners/losers
     */
    function processRouletteResult(uint256 roundId, IRoulette.PayoutInfo[] memory payouts, uint256 totalPayouts, bool isLastBatch) external onlyRoulette {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        uint256 payoutsLength = payouts.length;
        
        IRoulette.PayoutInfo memory payoutInfo;
        // Process all payouts in a single transaction
        for (uint256 i; i < payoutsLength;) {
            payoutInfo = payouts[i];
            IERC20(BRB_TOKEN).transfer(payoutInfo.player, payoutInfo.payout);
            // Note: We don't process losers' bets here - they remain in the vault
            // Losers' losses are automatically added to staker profits when we reset pendingBets
            
            unchecked { ++i; }
        }

        $.totalPayouts[roundId] += totalPayouts;
        
        // If this is the last batch, track pending bets for this round
        if (isLastBatch) {
            // Store pending bets for this round (for fee calculation)
            // Reduce total pending bets by the amount for this round
            // This correctly reflects the assets available to stakers after round resolution
            $.pendingBets -= $.pendingBetsPerRound[roundId];
            
            // Update lastRoundPaid to track completed rounds
            $.lastRoundPaid = roundId;
            
            // NOTE: Withdrawals remain locked until cleaning upkeep processes large withdrawals
            // This ensures proper order: process withdrawals first, then unlock
        } 
    }


         /**
     * @dev Register cleaning upkeep (admin only)
     * @param linkAmount Amount of LINK to fund the upkeep (18 decimals)
     */
    function registerCleaningUpkeep(
        uint96 linkAmount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if ($.keeperRegistrar == address(0)) revert ZeroAmount();
        
        // Transfer LINK from caller to this contract for upkeep funding
       IERC20($.linkToken).transferFrom(msg.sender, address(this), linkAmount);
        
        string memory upkeepName = string.concat(
            "StakedBRB-Cleaning-",
            Strings.toHexString(address(this))
        );
        
        uint256 upkeepId = IAutomationRegistrar2_1($.keeperRegistrar).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: address(this),
                gasLimit: CLEANING_UPKEEP_GAS_LIMIT,
                adminAddress: msg.sender,
                triggerType: 0, // Conditional trigger
                checkData: new bytes(0), // Empty = protocol fees, length determines withdrawal batch
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );
        
        if (upkeepId == 0) revert UpkeepRegistrationFailed();
        
        // Get forwarder address and register it
        address forwarder = IAutomationRegistry2_1($.keeperRegistry).getForwarder(upkeepId);
        $.forwarders[forwarder] = upkeepId;
        
        emit CleaningUpkeepRegistered(upkeepId, forwarder, CLEANING_UPKEEP_GAS_LIMIT, linkAmount, "Cleaning");
        return upkeepId;
    }
    
    /**
     * @dev Handle round transition - called by Roulette contract when VRF is triggered
     * @dev This ensures both contracts stay synchronized and state is properly reset
     * @dev Also processes queued large withdrawals in batches
     * @param newRoundId ID of the new round starting
     * @param previousRoundId ID of the round that just finished
     */
    function onRoundTransition(uint256 newRoundId, uint256 previousRoundId) external onlyRoulette {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Mark that a round transition is in progress - this blocks deposits/withdrawals
        $.roundTransitionInProgress = true;
        
        // Update current round - SINGLE SOURCE OF TRUTH for round state
        // This ensures proper synchronization between StakedBRB and RouletteClean
        $.currentRound = newRoundId;
        
        emit RoundTransition(previousRoundId, newRoundId);
    }
    
    /// @dev Process a batch of large withdrawals using pre-computed data from checkUpkeep
    function _processLargeWithdrawalBatchPreComputed(
        address[] memory usersToProcess,
        uint256[] memory amountsToProcess,
        uint256 actualProcessCount
    ) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        if (actualProcessCount == 0) return; // No withdrawals to process
        
        address user;
        uint256 amount;
        uint256 queueIndex;
        // Process pre-computed withdrawals (no computations needed - all done in checkUpkeep)
        for (uint256 i = 0; i < actualProcessCount;) {
            user = usersToProcess[i];
            amount = amountsToProcess[i];
            
            // Execute withdrawal (no safety checks - already validated in checkUpkeep)
            _executeLargeWithdrawal(user, amount);
            
            // Remove from queue efficiently
            queueIndex = $.userQueuePosition[user];
            if (queueIndex != 0) {
                _removeUserFromQueueEfficient(queueIndex);
            }
            
            unchecked { ++i; }
        }
    }
    
    /// @dev Process a batch of large withdrawals from the queue using dynamic array
    function _processLargeWithdrawalBatch() private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        uint256 queueSize = $.queueSize;
        if (queueSize == 0) return; // No withdrawals to process
        
        uint256 batchSize = $.largeWithdrawalBatchSize;
        uint256 withdrawalsToProcess = queueSize > batchSize ? batchSize : queueSize;
        
        // Process withdrawals from the front of the queue (FIFO)
        uint256 processedCount;
        uint256 currentIndex = $.queueHead;
        uint256 maxIterations = queueSize; // Prevent infinite loops
        
        address user;
        uint256 amount;
        while (processedCount < withdrawalsToProcess && $.queueSize > 0 && maxIterations > 0) {
            // Check bounds to prevent array access out of bounds
            if (currentIndex >= $.largeWithdrawalQueue.length) {
                break; // Reached end of array
            }
            
            user = $.largeWithdrawalQueue[currentIndex];
            
            // Skip empty slots (users who cancelled while in queue)
            if (user == address(0)) {
                // Move to next slot
                currentIndex = currentIndex + 1;
                maxIterations--;
                continue;
            }
            
            amount = $.pendingLargeWithdrawals[user];
            
            // At this point, user is guaranteed to be valid and have amount > 0
            // because we skip address(0) slots above
            
            // Check if we can safely process this withdrawal
            if (_calculateSafeWithdrawalCapacity() >= amount) {
                // Process the withdrawal (burn shares and transfer BRB)
                _executeLargeWithdrawal(user, amount);
                
                // Remove from queue efficiently
                _removeUserFromQueueEfficient(currentIndex);
                processedCount++;
                
                // Note: After removal, the next user is still at currentIndex
                // because we're using a dynamic array with empty slot marking
            } else {
                // Not safe to process - move to next user
                currentIndex = currentIndex + 1;
            }
            
            maxIterations--;
        }
        
        // Update queue head to point to next user to process
        if ($.queueSize > 0) {
            $.queueHead = currentIndex;
        }
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
    
    /// @dev Execute a large withdrawal
    /// @dev Uses standard ERC4626 flow: burns correct shares and transfers full amount to user
    function _executeLargeWithdrawal(address user, uint256 amount) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Use super.withdraw to handle the standard ERC4626 flow
        // This automatically burns shares and transfers the full amount to user
        super.withdraw(amount, user, user, 0);
        
        // Clear pending withdrawal
        $.pendingLargeWithdrawals[user] = 0;
        $.totalPendingLargeWithdrawals -= amount;

        emit LargeWithdrawalProcessed(user, amount);
    }
    
    /// @dev Remove user from queue efficiently using dynamic array
    function _removeUserFromQueueEfficient(uint256 index) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        require(index < $.largeWithdrawalQueue.length, IndexOutOfBounds());
        require($.queueSize > 0, QueueIsEmpty());
        
        // Get the user being removed
        address userToRemove = $.largeWithdrawalQueue[index];
        
        // Clear user's queue position and pending withdrawal
        $.userQueuePosition[userToRemove] = 0;
        
        // Mark slot as empty (we'll reuse it)
        $.largeWithdrawalQueue[index] = address(0);
        
        // Decrease queue size
        $.queueSize--;
        
        // If queue is now empty, reset pointers
        if ($.queueSize == 0) {
            $.queueHead = 0;
            $.queueTail = 0;
        }
    }
    
    /**
     * @dev Calculate protocol fee from betting loss using OpenZeppelin's math
     * @param lossAmount Amount lost by player
     * @return protocolFee Amount that goes to protocol
     */
    function _calculateProtocolFee(uint256 lossAmount) private view returns (uint256 protocolFee) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        if (lossAmount == 0 || $.protocolFeeBasisPoints == 0) return 0;
        
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
    * @dev Override deposit to enforce minimum deposit
    */
    function deposit(uint256 assets, address receiver, uint256 minSharesOut) public override returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (totalSupply() == 0 && assets < MINIMUM_FIRST_DEPOSIT) {
            revert DepositTooSmall();
        }
        _checkDepositAllowed();
        return super.deposit(assets, receiver, minSharesOut);
    }

    function mint(uint256 shares, address receiver, uint256 maxAmountIn) public override returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (totalSupply() == 0 && shares < MINIMUM_FIRST_DEPOSIT) {
            revert DepositTooSmall();
        }
        _checkDepositAllowed();
        return super.mint(shares, receiver, maxAmountIn);
    }

    // === Note: No ERC4626 Fee Overrides ===
    // We use pure ERC4626 without deposit/withdrawal fees
    // All fees come from betting losses, handled in processRouletteResult()
    
    /**
     * @dev Override withdraw to implement two-tier withdrawal system
     * @dev Small withdrawals are processed immediately, large withdrawals go to queue
     */
    function withdraw(uint256 assets, address receiver, address owner, uint256 maxSharesOut) public override noPendingLargeWithdrawal(owner) returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        
        // Check if withdrawal is allowed at all
        _checkWithdrawalAllowed(owner);
        
        // Process withdrawal using shared logic
        (bool isLarge, uint256 safeAmount) = _processWithdrawalRequest(assets, owner);
        
        if (isLarge) {
            // Large withdrawal: return shares that will be burned when processed
            return super.previewWithdraw(assets);
        } else {
            // Small withdrawal: process immediately
            return super.withdraw(safeAmount, receiver, owner, maxSharesOut);
        }
    }
    
    /// @dev Override redeem to implement two-tier withdrawal system (consistent with withdraw)
    function redeem(uint256 shares, address receiver, address owner, uint256 minAmountOut) public override noPendingLargeWithdrawal(owner) returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        
        // Check if withdrawal is allowed at all
        _checkWithdrawalAllowed(owner);
        
        // Calculate assets from shares
        uint256 requestedAssets = super.previewRedeem(shares);
        
        // Process withdrawal using shared logic
        (bool isLarge,) = _processWithdrawalRequest(requestedAssets, owner);
        
        if (isLarge) {
            // Large withdrawal: return assets that will be transferred when processed
            return requestedAssets;
        } else {
            // Small withdrawal: process immediately
            return super.redeem(shares, receiver, owner, minAmountOut);
        }
    }
    
    /// @dev Shared logic for processing withdrawal requests (both withdraw and redeem)
    /// @param requestedAssets Amount of assets requested
    /// @return isLarge Whether this is a large withdrawal that needs queuing
    /// @return safeAmount Safe amount that can be withdrawn immediately (if not large)
    function _processWithdrawalRequest(uint256 requestedAssets, address owner) private returns (bool isLarge, uint256 safeAmount) {        
        // Check if this is a large withdrawal
        isLarge = _isLargeWithdrawal(requestedAssets);
        
        if (isLarge) {

            if (owner != msg.sender) { // can't use allowance for queued withdrawals
                revert UnauthorizedCaller();
            }

            // Pre-validate all conditions to prevent reverts
            _validateLargeWithdrawalRequest(requestedAssets);
            
            // Queue the withdrawal (user keeps shares for now)
            _requestLargeWithdrawal(requestedAssets);
        } else {
            // Small withdrawal: user can get what they requested
            safeAmount = requestedAssets;
        }
    }

    function _checkDepositAllowed() private view {
       StakedBRBStorage storage $ = _getStakedBRBStorage();
        // Block deposits during round transitions (from onRoundTransition to cleaning upkeep completion)
        if ($.roundTransitionInProgress) {
            revert DepositBlockedDuringResolution();
        }
    }
    
    /// @dev Private function to check if withdrawals are allowed
    function _checkWithdrawalAllowed(address owner) private view {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        // Block withdrawals during round transitions (from onRoundTransition to cleaning upkeep completion)
        if ($.roundTransitionInProgress) {
            revert WithdrawalBlockedDuringResolution();
        }

        if ($.pendingLargeWithdrawals[owner] > 0) {
            revert LargeWithdrawalPending();
        }
    }
    
    /// @dev Check if withdrawal amount is considered "large" and requires special handling
    /// @dev A withdrawal is "large" if it would risk the vault's ability to pay current round winners
    function _isLargeWithdrawal(uint256 assets) private view returns (bool) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Get current total assets and maxPayout
        uint256 currentTotalAssets = totalAssets();
        uint256 currentMaxPayout = $.maxPayout;
        
        // Calculate safe withdrawal capacity
        uint256 safeCapacity = currentTotalAssets > currentMaxPayout ? currentTotalAssets - currentMaxPayout : 0;
        
        // Large withdrawal if it exceeds the safe capacity
        // If safeCapacity = 0, all withdrawals are large (no immediate withdrawals allowed)
        return assets > safeCapacity;
    }
    
    /// @dev Pre-validate all conditions for large withdrawal request to prevent reverts
    /// @dev This ensures the withdrawal request will succeed before we return shares
    function _validateLargeWithdrawalRequest(uint256 amount) private view {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // 1. Check if user is already in queue
        if ($.pendingLargeWithdrawals[msg.sender] > 0) {
            revert LargeWithdrawalPending();
        }
        
        // 2. Check queue size limit (not array length)
        if ($.queueSize >= $.maxQueueLength) {
            revert QueueFull();
        }
        
        // 4. Check if user has sufficient balance (prevent fake requests)
        uint256 userBalance = balanceOf(msg.sender);
        if (userBalance < amount) {
            revert WithdrawalTooLarge();
        }
    }
    
    /// @dev Request a large withdrawal and add to queue (validation already done)
    function _requestLargeWithdrawal(uint256 amount) private {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // ALL CHECKS ALREADY PASSED - Add to queue
        
        // Add to pending large withdrawals
        $.pendingLargeWithdrawals[msg.sender] = amount;
        $.totalPendingLargeWithdrawals += amount;
        
        uint256 queueTail = $.queueTail;

        // Ensure the array is large enough before accessing the index
        // If queueTail is beyond current array length, push to extend it
        if (queueTail >= $.largeWithdrawalQueue.length) {
            $.largeWithdrawalQueue.push(msg.sender);
        } else {
            $.largeWithdrawalQueue[queueTail] = msg.sender;
        }
        
        $.userQueuePosition[msg.sender] = queueTail; // Store user's position for O(1) access (0-based)
        $.queueTail = queueTail + 1; // No modulo needed for dynamic array
        $.queueSize++;
        
        emit LargeWithdrawalRequested(msg.sender, amount);
    }
    /**
     * @dev Update large withdrawal batch size (admin only)
     * @param newBatchSize Number of withdrawals to process per round transition
     */
    function setLargeWithdrawalBatchSize(uint256 newBatchSize) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBatchSize == 0 || newBatchSize > MAX_LARGE_WITHDRAWAL_BATCH_SIZE) revert InvalidWithdrawalBatchSize();
        
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        $.largeWithdrawalBatchSize = newBatchSize;
        
        emit WithdrawalSettingsUpdated(newBatchSize);
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
        address feeRecipient,
        uint256 pendingBets
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        return (
            BRB_TOKEN,
            ROULETTE_CONTRACT,
            $.protocolFeeBasisPoints,
            $.feeRecipient,
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

    function getSafeCapacity() external view returns (uint256) {
        return _calculateSafeWithdrawalCapacity();
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
     * @dev Get withdrawal settings and status
     * @return largeWithdrawalBatchSize Current batch size for processing
     * @return totalPendingLargeWithdrawals Total amount of pending large withdrawals
     * @return queueLength Current length of withdrawal queue
     * @return maxQueueLength Maximum allowed queue length
     */
    function getWithdrawalSettings() external view returns (
        uint256 largeWithdrawalBatchSize,
        uint256 totalPendingLargeWithdrawals,
        uint256 queueLength,
        uint256 maxQueueLength
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        largeWithdrawalBatchSize = $.largeWithdrawalBatchSize;
        totalPendingLargeWithdrawals = $.totalPendingLargeWithdrawals;
        queueLength = $.queueSize;
        maxQueueLength = $.maxQueueLength;
    }
    
    /**
     * @dev Get user's pending large withdrawal information
     * @param user Address to check
     * @return pendingAmount Amount pending for withdrawal
     * @return queuePosition Position in withdrawal queue (0 = not in queue)
     */
    function getUserPendingWithdrawal(address user) external view returns (
        uint256 pendingAmount,
        uint256 queuePosition
    ) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        pendingAmount = $.pendingLargeWithdrawals[user];
        
        if (pendingAmount > 0) {
            queuePosition = _getUserQueuePosition(user); // Restored - accounts for cancelled users
        }
    }
    
    /**
     * @dev Allow users to cancel their pending large withdrawal request
     * @dev This helps with queue management and user experience
     */
    function cancelLargeWithdrawal() external {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        uint256 pendingAmount = $.pendingLargeWithdrawals[msg.sender];
        if (pendingAmount == 0) revert LargeWithdrawalPending(); // User not in queue
        
        // Get user's position directly from mapping (O(1) access)
        uint256 queueIndex = $.userQueuePosition[msg.sender];
        
        // Check if user is actually in the queue by verifying the queue slot contains their address
        // This handles the case where queueIndex = 0 (first user) and prevents false positives
        if (queueIndex >= $.largeWithdrawalQueue.length || $.largeWithdrawalQueue[queueIndex] != msg.sender) {
            revert UserNotInQueue();
        }
        
        // Remove from queue efficiently
        _removeUserFromQueueEfficient(queueIndex);
        
        // Clear pending withdrawal
        $.pendingLargeWithdrawals[msg.sender] = 0;
        $.totalPendingLargeWithdrawals -= pendingAmount;
        
        emit LargeWithdrawalProcessed(msg.sender, pendingAmount);
    }
    
    /// @dev Get user's position in queue (accounts for cancelled users)
    function _getUserQueuePosition(address user) private view returns (uint256) {
        StakedBRBStorage storage $ = _getStakedBRBStorage();
        
        // Get user's queue index
        uint256 queueIndex = $.userQueuePosition[user];
        // Check if user is in queue by looking at pendingLargeWithdrawals
        if ($.pendingLargeWithdrawals[user] == 0) return 0; // User not in queue
        
        // Calculate actual position by counting non-empty slots from queueHead
        uint256 position = 0;
        uint256 currentIndex = $.queueHead;
        uint256 maxIterations = $.queueSize; // Prevent infinite loops
        
        while (currentIndex != queueIndex && maxIterations > 0) {
            // Check bounds to prevent array access out of bounds
            if (currentIndex >= $.largeWithdrawalQueue.length) {
                break; // Reached end of array
            }
            
            if ($.largeWithdrawalQueue[currentIndex] != address(0)) {
                position++;
            }
            currentIndex = currentIndex + 1;
            maxIterations--;
        }
        
        // If we found the user, return their position (1-indexed for user display)
        if (currentIndex == queueIndex) {
            return position + 1;
        }
        
        return 0; // User not found (shouldn't happen if queue state is correct)
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
