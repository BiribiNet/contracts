// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { VRFConsumerBaseV2 } from "./external/VRFConsumerBaseV2.sol";
import { VRFV2PlusClient } from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import { VRFCoordinatorV2Interface } from "@chainlink/contracts/src/v0.8/vrf/interfaces/VRFCoordinatorV2Interface.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";
import { IStakedBRB } from "./interfaces/IStakedBRB.sol";
import { IJackpotContract } from "./interfaces/IJackpotContract.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBRBUpkeepManager } from "./interfaces/IBRBUpkeepManager.sol";
import { RouletteLib } from "./RouletteLib.sol";
/**
 * @title RouletteClean
 * @dev SIMPLE roulette contract - easy to understand
 */
contract RouletteClean is AccessControlUpgradeable, VRFConsumerBaseV2, UUPSUpgradeable, AutomationCompatibleInterface, IRoulette {
    
    // ========== SIMPLE CONSTANTS ==========
    /// @dev No-bet lock after GAME_PERIOD lasts 6–10s: 6 + (lastRoundStartTime % 5)
    uint256 private constant NO_BET_LOCK_MIN = 6;
    uint256 private constant NO_BET_LOCK_MOD = 5;
    uint32 private constant BATCH_SIZE = 35; // Users per batch for payout processing
    
    // GAS LIMIT CALCULATION FOR WORST-CASE SCENARIO (all bets win)
    uint32 private constant BASE_GAS_OVERHEAD = 100000; // Base transaction overhead
    uint32 private constant GAS_PER_WINNING_BET = 50000; // Gas per winning bet payout (transfer + events)
    uint32 private constant MAX_GAS_LIMIT = 5000000; // Conservative limit under Chainlink's default 10M
    
    // CALCULATED GAS LIMIT: Covers BATCH_SIZE winning bets + overhead
    uint32 private constant UPKEEP_GAS_LIMIT = BASE_GAS_OVERHEAD + (BATCH_SIZE * GAS_PER_WINNING_BET);
    uint256 private immutable GAME_PERIOD; // e.g., 60 seconds per round
    
    // EIP-7201 storage location
    // keccak256(abi.encode(uint256(keccak256("biribi.storage.roulette")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant MAIN_STORAGE_LOCATION = 0xf43a8193525cdc4f151449ab92422891f2ec4b8333fb77c0464afa0d4b22a900;
    
    // VRF settings
    uint256 private immutable SUBSCRIPTION_ID;
    bytes32 private immutable KEY_HASH_2GWEI;
    bytes32 private immutable KEY_HASH_30GWEI;
    bytes32 private immutable KEY_HASH_150GWEI;
    uint32 private immutable CALLBACK_GAS_LIMIT;
    uint32 private immutable NUMWORDS;
    uint16 private immutable SAFE_BLOCK_CONFIRMATION;
    
    // StakedBRB contract - only one allowed
    address private immutable STAKED_BRB_CONTRACT;
    address private immutable LINK_TOKEN;
    address private immutable JACKPOT_CONTRACT;
    address private immutable BRB_TOKEN;
    /// @dev Authorizes Chainlink forwarders; forwarders are only added via BRBUpkeepManager after registrar success
    address private immutable UPKEEP_MANAGER;

    struct ConstructorParams {
        uint256 gamePeriod;
        address vrfCoordinator;
        bytes32 keyHash2Gwei;
        bytes32 keyHash30Gwei;
        bytes32 keyHash150Gwei;
        uint256 subscriptionId;
        uint32 callbackGasLimit;
        uint32 numWords;
        uint16 safeBlockConfirmation;
        address stakedBRBContract;
        address linkToken;
        address jackpotContract;
        address brbToken;
        address upkeepManager;
    }
    
    // ========== BET STRUCTS ==========
    struct Bet {
        address player;
        uint256 amount;
        uint256 number; // Primary number/identifier for the bet
    }
    
    struct MultipleBets {
        uint256[] amounts;   // Array of bet amounts
        uint256[] betTypes;  // Array of bet types
        uint256[] numbers;   // Array of numbers (0 for non-straight bets)
    }
    
    // ========== UPKEEP STRUCTS ==========
    struct ComputeTotalWinningBetsData {
        uint256 totalWinningBets;
        uint256 jackpotWinnerCount;
        uint256 totalJackpotBetAmount; // Sum of all bets eligible for jackpot (for proportional share)
    }
    
    struct RandomResult {
        uint256 winningNumber;
        uint256 jackpotNumber;
        bool set; // Whether VRF result is available
    }
    
    struct JackpotPayoutPayload {
        IRoulette.PayoutInfo[] payouts;
        uint256 batchIndex;
    }
    
    struct JackpotResult {
        uint256 totalJackpotBetAmount; // Total bet amount on winning jackpot number (denominator for proportional calc)
        uint256 jackpotWinnerCount;
        uint256 jackpotAmount; // Jackpot pool at time of win (numerator for proportional calc)
    }

    /// @dev Matches performData `kind` and aligns with checkData routing: empty checkData => PreVrfLock (0); hex"01" => Vrf (1); length 2 => Compute…; length>=3 => payout batches.
    enum UpkeepKind {
        PreVrfLock,
        Vrf,
        ComputeTotalWinningBets,
        PayoutBatch,
        JackpotPayoutBatch
    }
    
    struct PerformDataPayload {
        uint256 roundId;
        UpkeepKind kind;
        bytes payload;
    }
    
    struct TriggerVRF {
        uint256 newRoundId;
    }
    
    struct PayoutBatch {
        uint256 totalPayouts;
        IRoulette.PayoutInfo[] payouts; // Pre-computed payouts for this batch
        uint256 batchIndex; // Pre-computed batch index
    }
    
    struct CollectWinningsValues {
        uint256 payoutCount;
        uint256 totalPayouts;
        uint256 currentIndex;
        uint256 endIndex;
    }
    
    struct SkipOrProcessSimpleBetsValues {
        uint256 betsLength;
        uint256 batchStart;
        uint256 batchEnd;
    }

    
    // ========== EIP-7201 STORAGE ==========
    struct RouletteStorage {
        uint256 currentRound;
        uint256 lastRoundStartTime;
        uint256 lastRoundPaid; // Last round where all users were paid
        
        // EFFICIENT BET COUNTER (instead of gas-intensive loops)
        mapping(uint256 => uint256) totalBetsInRound; // roundId => total bet count
        
        // ATOMIC BATCH TRACKING (prevent parallel execution issues)
        // Uses bitmap where bit N = 1 if batch N has been processed
        // This prevents race conditions and ensures sequential processing
        mapping(uint256 => uint256) roundBatchBitmap; // roundId => bitmap of processed batches

        mapping(uint256 => uint256) totalWinningBets; // roundId => total winning bets
        mapping(uint256 => bool) totalWinningBetsSet; // roundId => total winning bets set
        mapping(uint256 => uint256) winningBetsProcessed; // roundId => bet processed
        
        uint256 minJackpotCondition;
        
        // EFFICIENT BET STORAGE BY TYPE (like casino dealer sections)
        mapping(uint256 => mapping(uint256 => uint256)) roundBigStraightBetsSum;   // roundId => number => straight bets > minJackpotCondition
        mapping(uint256 => mapping(uint256 => Bet[])) roundBigStraightBets;   // roundId => number => straight bets > minJackpotCondition
        mapping(uint256 => mapping(uint256 => Bet[])) roundSmallStraightBets;   // roundId => number => straight bets < minJackpotCondition
        mapping(uint256 => mapping(uint256 => Bet[])) roundSplitBets;      // roundId => splitId => split bets  
        mapping(uint256 => mapping(uint256 => Bet[])) roundStreetBets;     // roundId => street => street bets
        mapping(uint256 => mapping(uint256 => Bet[])) roundCornerBets;     // roundId => cornerId => corner bets
        mapping(uint256 => mapping(uint256 => Bet[])) roundLineBets;       // roundId => lineId => line bets
        mapping(uint256 => mapping(uint256 => Bet[])) roundColumnBets;     // roundId => column => column bets
        mapping(uint256 => mapping(uint256 => Bet[])) roundDozenBets;      // roundId => dozen => dozen bets
        mapping(uint256 => Bet[]) roundRedBets;       // roundId => red bets
        mapping(uint256 => Bet[]) roundBlackBets;     // roundId => black bets
        mapping(uint256 => Bet[]) roundOddBets;       // roundId => odd bets
        mapping(uint256 => Bet[]) roundEvenBets;      // roundId => even bets
        mapping(uint256 => Bet[]) roundLowBets;       // roundId => low bets (1-18)
        mapping(uint256 => Bet[]) roundHighBets;      // roundId => high bets (19-36)
        mapping(uint256 => Bet[]) roundTrio012Bets;   // roundId => trio 0-1-2 bets
        mapping(uint256 => Bet[]) roundTrio023Bets;   // roundId => trio 0-2-3 bets
        mapping(uint256 => JackpotResult) jackpotResult; // roundId => jackpot result
        mapping(uint256 => RandomResult) randomResults; // roundId => VRF result
        mapping(uint256 => uint256) requestIdToRound; // VRF request => round
        
        // OPTIMIZED MAXPAYOUT TRACKING
        mapping(uint256 => uint256) roundMaxStraightBet;  // roundId => max total straight bet amount across all numbers (single SLOAD)
        mapping(uint256 => mapping(uint256 => uint256)) roundStraightBetsTotal; // roundId => number => total straight bets (big + small) for per-number tracking
        mapping(uint256 => uint256) roundMaxStreetBet;    // roundId => max total street bet amount across all streets (single SLOAD)
        mapping(uint256 => mapping(uint256 => uint256)) roundStreetBetsTotal;   // roundId => streetId => total street bets for per-street tracking
        mapping(uint256 => uint256) roundRedBetsSum;      // roundId => total red bets
        mapping(uint256 => uint256) roundBlackBetsSum;    // roundId => total black bets
        mapping(uint256 => uint256) roundOddBetsSum;      // roundId => total odd bets
        mapping(uint256 => uint256) roundEvenBetsSum;     // roundId => total even bets
        mapping(uint256 => uint256) roundLowBetsSum;       // roundId => total low bets
        mapping(uint256 => uint256) roundHighBetsSum;     // roundId => total high bets
        mapping(uint256 => mapping(uint256 => uint256)) roundDozenBetsSum;   // roundId => dozen => total dozen bets
        mapping(uint256 => mapping(uint256 => uint256)) roundColumnBetsSum;  // roundId => column => total column bets
        mapping(uint256 => uint256) roundOtherBetsPayout; // roundId => sum of splits/corners/lines/trios payouts (streets excluded)
    }
    
    
    function _getRouletteStorage() private pure returns (RouletteStorage storage $) {
        assembly {
            $.slot := MAIN_STORAGE_LOCATION
        }
    }
    
    // ========== BET TYPES (European Roulette) ==========
    uint256 constant BET_STRAIGHT = 1;    // Single number (0-36)
    uint256 constant BET_SPLIT = 2;       // Two adjacent numbers
    uint256 constant BET_STREET = 3;      // Three numbers in a row
    uint256 constant BET_CORNER = 4;      // Four numbers in a square
    uint256 constant BET_LINE = 5;        // Six numbers (two streets)
    uint256 constant BET_COLUMN = 6;      // Column bet (12 numbers)
    uint256 constant BET_DOZEN = 7;       // Dozen bet (12 numbers)
    uint256 constant BET_RED = 8;         // Red numbers
    uint256 constant BET_BLACK = 9;       // Black numbers  
    uint256 constant BET_ODD = 10;        // Odd numbers
    uint256 constant BET_EVEN = 11;       // Even numbers
    uint256 constant BET_LOW = 12;        // Low numbers (1-18)
    uint256 constant BET_HIGH = 13;       // High numbers (19-36)
    uint256 constant BET_TRIO_012 = 14;   // Trio 0-1-2
    uint256 constant BET_TRIO_023 = 15;   // Trio 0-2-3
    
    // ========== EVENTS ==========
    event MinJackpotConditionUpdated(uint256 newMinJackpotCondition);
    event VrfRequested(uint256 indexed newRoundId, uint256 requestId, uint256 timestamp);
    event RoundResolved(uint256 roundId);
    event VRFResult(uint256 roundId, uint256 winningNumber, uint256 jackpotNumber);
    event BatchProcessed(uint256 roundId, uint256 batchIndex, uint256 payoutsCount);
    event JackpotResultEvent(uint256 roundId, uint256 jackpotWinnerCount);
    event ComputedPayouts(uint256 roundId, uint256 totalWinningBets);
    
    // ========== ERRORS ==========
    error InvalidBet();
    error ZeroAddress();
    error ZeroAmount();
    error MalformedData();
    error InvalidBetType();
    error InvalidNumber();
    error ArrayLengthMismatch();
    error EmptyBetsArray();
    error InvalidRequestId();
    error StakedBRBCallFailed();
    error UnauthorizedCaller();
    error OnlyForwarders();
    error BetLimitExceeded();
    error BettingClosed();
    /// @dev Initialize RouletteClean only after StakedBRB.initialize so boundary timestamp is set.
    error StakedBRBNotInitialized();
    
    constructor(ConstructorParams memory params) VRFConsumerBaseV2(params.vrfCoordinator) {
        GAME_PERIOD = params.gamePeriod;
        KEY_HASH_2GWEI = params.keyHash2Gwei;
        KEY_HASH_30GWEI = params.keyHash30Gwei;
        KEY_HASH_150GWEI = params.keyHash150Gwei;
        SUBSCRIPTION_ID = params.subscriptionId;
        CALLBACK_GAS_LIMIT = params.callbackGasLimit;
        NUMWORDS = params.numWords;
        SAFE_BLOCK_CONFIRMATION = params.safeBlockConfirmation;
        STAKED_BRB_CONTRACT = params.stakedBRBContract;
        LINK_TOKEN = params.linkToken;
        JACKPOT_CONTRACT = params.jackpotContract;
        BRB_TOKEN = params.brbToken;
        if (params.upkeepManager == address(0)) revert ZeroAddress();
        UPKEEP_MANAGER = params.upkeepManager;
        _disableInitializers();
    }
    
    function initialize(
        uint256 minJackpotCondition,
        address admin
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        
        RouletteStorage storage $ = _getRouletteStorage();
        $.currentRound = 1;
        uint256 boundaryTs = IStakedBRB(STAKED_BRB_CONTRACT).lastRoundBoundaryTimestamp();
        if (boundaryTs == 0) revert StakedBRBNotInitialized();
        $.lastRoundStartTime = boundaryTs;
        $.minJackpotCondition = minJackpotCondition;
    }
    
    // ========== MODIFIERS ==========
    
    /**
     * @dev Only Chainlink forwarders recorded by BRBUpkeepManager (no direct forwarder edits on this contract)
     */
    modifier onlyForwarders() {
        if (!IBRBUpkeepManager(UPKEEP_MANAGER).isAuthorizedForwarder(msg.sender)) revert OnlyForwarders();
        _;
    }

    modifier onlyStakedBRBContract() {
        if (msg.sender != STAKED_BRB_CONTRACT) revert UnauthorizedCaller();
        _;
    }
    
    function setMinJackpotCondition(uint256 newMinCondition) external onlyRole(DEFAULT_ADMIN_ROLE) {
        RouletteStorage storage $ = _getRouletteStorage();
        $.minJackpotCondition = newMinCondition;
    }
    
    /**
     * @dev Called when user places bet(s) - supports multiple bets in one call
     * @param sender Who placed the bet
     * @param totalValue Total amount bet (in wei) across all bets
     * @param data Bet data: abi.encode(MultipleBets) OR abi.encode(betType, number) for single bet
     */
    function bet(address sender, uint256 totalValue, bytes calldata data) 
        external override returns (uint256)
    {
        // Only allow calls from the immutable StakedBRB contract
        if (msg.sender != STAKED_BRB_CONTRACT) revert UnauthorizedCaller();
        
        if (totalValue == 0) revert ZeroAmount();
        if (data.length == 0) revert MalformedData();
        
        RouletteStorage storage $ = _getRouletteStorage();
        
        // ALWAYS decode as MultipleBets - direct decoding for gas efficiency
        // abi.decode will revert automatically on malformed data
        return _processMultipleBets(sender, totalValue, abi.decode(data, (MultipleBets)), $);
    }
    
    /**
     * @dev Process multiple bets
     */
    function _requireBetCapacity(RouletteStorage storage $, uint256 currentRound, uint256 betsLength) private view {
        if ($.totalBetsInRound[currentRound] + betsLength > IBRBUpkeepManager(UPKEEP_MANAGER).maxSupportedBets()) {
            revert BetLimitExceeded();
        }
    }

    function _processMultipleBets(address sender, uint256 totalValue, MultipleBets memory bets, RouletteStorage storage $) private returns (uint256 maxPayout) {
        unchecked {
            uint256 betsLength = bets.amounts.length; // Cache array length

            // Validate arrays have same length
            if (betsLength != bets.betTypes.length || betsLength != bets.numbers.length) {
                revert ArrayLengthMismatch();
            }

            if (betsLength == 0) revert EmptyBetsArray();

            if (!_isBettingOpen()) revert BettingClosed();

            // Cache storage reads
            uint256 currentRound = $.currentRound;

            _requireBetCapacity($, currentRound, betsLength);

            // SINGLE LOOP: Validate total AND process bets in one pass
            uint256 calculatedTotal;
            uint256 amount;
            uint256 minJackpotCondition = $.minJackpotCondition;
            for (uint256 i; i < betsLength;) {
                amount = bets.amounts[i];
                calculatedTotal += amount;

                // Validate and store bet (now tracks optimized components)
                _validateAndStoreBet(
                    sender,
                    amount,
                    bets.betTypes[i],
                    bets.numbers[i],
                    currentRound,
                    minJackpotCondition,
                    $
                );

                ++i;
            }

            // Validate total amount matches
            if (calculatedTotal != totalValue) revert InvalidBet();

            $.totalBetsInRound[currentRound] = $.totalBetsInRound[currentRound] + betsLength;
            
            // Calculate optimized maxPayout from tracked components
            maxPayout = _calculateMaxPayoutFromStorage(currentRound, $);
        }
    }
    
    /**
     * @dev Calculate maxPayout from storage (separate function to avoid stack too deep)
     */
    function _calculateMaxPayoutFromStorage(uint256 roundId, RouletteStorage storage $) private view returns (uint256) {
        // Pass storage references directly to library - no memory copying
        return ((RouletteLib.calculateStraightStreetComponents(roundId, $.roundMaxStraightBet, $.roundMaxStreetBet) + RouletteLib.calculatePairComponents(roundId, $.roundRedBetsSum, $.roundBlackBetsSum, $.roundOddBetsSum, $.roundEvenBetsSum, $.roundLowBetsSum, $.roundHighBetsSum) + RouletteLib.calculateMaxPayoutPart2(roundId, $.roundDozenBetsSum, $.roundColumnBetsSum) + $.roundOtherBetsPayout[roundId]) * RouletteLib.SAFETY_BUFFER_BPS) / 10000;
    }
    /**
     * @dev Validate and store a single bet
     */
    function _validateAndStoreBet(
        address sender, 
        uint256 amount, 
        uint256 betType, 
        uint256 number,
        uint256 currentRound,
        uint256 minJackpotCondition,
        RouletteStorage storage $
    ) private returns (uint256 payout) {
        unchecked {
            // Validate bet amount
            if (amount < 10000 gwei) revert ZeroAmount(); // Minimum 10000 gwei per bet
            
            // Validate bet type
            if (betType == 0 || betType > BET_TRIO_023) revert InvalidBetType();
            
            // Store the bet in appropriate mapping for efficient lookup
            Bet memory newBet = Bet({
                player: sender,
                amount: amount,
                number: number
            });
            
            
            // DEALER-STYLE STORAGE: Each bet type goes to its specific section (using cached currentRound)
            if (betType == BET_STRAIGHT) {
                if (number > 36) revert InvalidNumber();
                payout = amount * 36;
                // Track total bets on this number (big + small) - single SLOAD
                uint256 totalOnThisNumber = $.roundStraightBetsTotal[currentRound][number] + amount;
                $.roundStraightBetsTotal[currentRound][number] = totalOnThisNumber;
                // Update max straight bet if this number's total exceeds current max
                if (totalOnThisNumber > $.roundMaxStraightBet[currentRound]) {
                    $.roundMaxStraightBet[currentRound] = totalOnThisNumber;
                }
                if (amount >= minJackpotCondition) {
                    $.roundBigStraightBets[currentRound][number].push(newBet);
                    $.roundBigStraightBetsSum[currentRound][number] += amount;
                } else {
                    $.roundSmallStraightBets[currentRound][number].push(newBet);
                }
            } else if (betType == BET_SPLIT) {
                if (!RouletteLib.isValidSplit(number)) revert InvalidNumber();
                payout = amount * 18;
                $.roundSplitBets[currentRound][number].push(newBet);
                // Track in other bets payout (non-optimized)
                $.roundOtherBetsPayout[currentRound] += payout;
            } else if (betType == BET_STREET) {
                if (number == 0 || number > 34 || (number - 1) % 3 != 0) revert InvalidNumber();
                payout = amount * 12;
                $.roundStreetBets[currentRound][number].push(newBet);
                // Track total street bets on this street ID (single SLOAD)
                uint256 totalOnThisStreet = $.roundStreetBetsTotal[currentRound][number] + amount;
                $.roundStreetBetsTotal[currentRound][number] = totalOnThisStreet;
                // Update max street bet if this street's total exceeds current max
                uint256 currentMaxStreet = $.roundMaxStreetBet[currentRound];
                if (totalOnThisStreet > currentMaxStreet) {
                    $.roundMaxStreetBet[currentRound] = totalOnThisStreet;
                }
            } else if (betType == BET_CORNER) {
                if (!RouletteLib.isValidCorner(number)) revert InvalidNumber();
                payout = amount * 9;
                $.roundCornerBets[currentRound][number].push(newBet);
                // Track in other bets payout (non-optimized)
                $.roundOtherBetsPayout[currentRound] += payout;
            } else if (betType == BET_LINE) {
                if (number == 0 || number > 31 || (number - 1) % 3 != 0) revert InvalidNumber();
                payout = amount * 6;
                $.roundLineBets[currentRound][number].push(newBet);
                // Track in other bets payout (non-optimized)
                $.roundOtherBetsPayout[currentRound] += payout;
            } else if (betType == BET_COLUMN) {
                if (number == 0 || number > 3) revert InvalidNumber();
                payout = amount * 3;
                $.roundColumnBets[currentRound][number].push(newBet);
                // Track column bets sum for optimization
                $.roundColumnBetsSum[currentRound][number] += amount;
            } else if (betType == BET_DOZEN) {
                if (number == 0 || number > 3) revert InvalidNumber();
                payout = amount * 3;
                $.roundDozenBets[currentRound][number].push(newBet);
                // Track dozen bets sum for optimization
                $.roundDozenBetsSum[currentRound][number] += amount;
            } else if (betType == BET_RED) {
                payout = amount * 2;
                $.roundRedBets[currentRound].push(newBet);
                // Track red bets sum for optimization
                $.roundRedBetsSum[currentRound] += amount;
            } else if (betType == BET_BLACK) {
                payout = amount * 2;
                $.roundBlackBets[currentRound].push(newBet);
                // Track black bets sum for optimization
                $.roundBlackBetsSum[currentRound] += amount;
            } else if (betType == BET_ODD) {
                payout = amount * 2;
                $.roundOddBets[currentRound].push(newBet);
                // Track odd bets sum for optimization
                $.roundOddBetsSum[currentRound] += amount;
            } else if (betType == BET_EVEN) {
                payout = amount * 2;
                $.roundEvenBets[currentRound].push(newBet);
                // Track even bets sum for optimization
                $.roundEvenBetsSum[currentRound] += amount;
            } else if (betType == BET_LOW) {
                payout = amount * 2;
                $.roundLowBets[currentRound].push(newBet);
                // Track low bets sum for optimization
                $.roundLowBetsSum[currentRound] += amount;
            } else if (betType == BET_HIGH) {
                payout = amount * 2;
                $.roundHighBets[currentRound].push(newBet);
                // Track high bets sum for optimization
                $.roundHighBetsSum[currentRound] += amount;
            } else if (betType == BET_TRIO_012) {
                payout = amount * 12;
                $.roundTrio012Bets[currentRound].push(newBet);
                // Track in other bets payout (non-optimized)
                $.roundOtherBetsPayout[currentRound] += payout;
            } else if (betType == BET_TRIO_023) {
                payout = amount * 12;
                $.roundTrio023Bets[currentRound].push(newBet);
                // Track in other bets payout (non-optimized)
                $.roundOtherBetsPayout[currentRound] += payout;
            }
        }
    }
    
    /**
     * @dev Chainlink Automation: Check if upkeep needed
     * @param checkData length 0 => UpkeepKind.PreVrfLock; length 1 (e.g. hex"01") => Vrf; length 2 => ComputeTotalWinningBets;
     *                  length >= 3 => payout batches (batch index = length - 3) => PayoutBatch or JackpotPayoutBatch.
     * SEQUENTIAL SAFETY: Batches are processed in order; batch N only after N-1 completes.
     */
    function checkUpkeep(bytes calldata checkData) external view override returns (bool upkeepNeeded, bytes memory performData) {
        RouletteStorage storage $ = _getRouletteStorage();

        if (checkData.length == 0) {
            uint256 srt = IStakedBRB(STAKED_BRB_CONTRACT).lastRoundBoundaryTimestamp();
            uint256 elapsed = block.timestamp - srt;
            // Pre-VRF lock: after betting window ends; must run before VRF (idempotent if already locked)
            upkeepNeeded = elapsed >= GAME_PERIOD
                && !IStakedBRB(STAKED_BRB_CONTRACT).roundResolutionLocked()
                && !IStakedBRB(STAKED_BRB_CONTRACT).roundTransitionInProgress();
            if (upkeepNeeded) {
                performData = abi.encode(PerformDataPayload({
                    roundId: 0,
                    kind: UpkeepKind.PreVrfLock,
                    payload: ""
                }));
            }
        } else if (checkData.length == 1) {
            uint256 srt = IStakedBRB(STAKED_BRB_CONTRACT).lastRoundBoundaryTimestamp();
            uint256 elapsed = block.timestamp - srt;
            uint256 lockDuration = NO_BET_LOCK_MIN + (srt % NO_BET_LOCK_MOD);
            uint256 currentRound = $.currentRound;
            // VRF: after GAME_PERIOD + no-bet lock, only if pre-lock upkeep ran
            upkeepNeeded = elapsed >= GAME_PERIOD + lockDuration
                && IStakedBRB(STAKED_BRB_CONTRACT).roundResolutionLocked()
                && !IStakedBRB(STAKED_BRB_CONTRACT).roundTransitionInProgress();

            if (upkeepNeeded) {
                performData = abi.encode(PerformDataPayload({
                    roundId: currentRound,
                    kind: UpkeepKind.Vrf,
                    payload: abi.encode(TriggerVRF({ newRoundId: currentRound + 1 }))
                }));
            }

        } else if (checkData.length == 2) {
            // COMPUTE TOTAL WINNING BETS: Check if we need to compute total winning bets
             uint256 roundToBePaid = $.lastRoundPaid + 1;
             RandomResult memory result = $.randomResults[roundToBePaid];
             if (roundToBePaid < $.currentRound && result.set && roundToBePaid > $.lastRoundPaid && !$.totalWinningBetsSet[roundToBePaid]) {
                uint256 random = result.winningNumber;
                (uint256 totalWinningBets, uint256 jackpotWinnerCount, uint256 totalJackpotBetAmount) = _countTotalWinningBets($, roundToBePaid, random, result.jackpotNumber, RouletteLib.getWinningBetTypes(random));
                upkeepNeeded = true;
                performData = abi.encode(PerformDataPayload({
                    roundId: roundToBePaid,
                    kind: UpkeepKind.ComputeTotalWinningBets,
                    payload: abi.encode(ComputeTotalWinningBetsData({
                        totalWinningBets: totalWinningBets,
                        jackpotWinnerCount: jackpotWinnerCount,
                        totalJackpotBetAmount: totalJackpotBetAmount
                    }))
                }));
             }
        } else {
            // PAYOUT USERS: Check if we need to pay users from completed rounds
            uint256 roundToBePaid = $.lastRoundPaid + 1;
            
            // Only process if round exists and has VRF result (check lastRoundPaid instead of roundResolved)
            if (roundToBePaid < $.currentRound && $.randomResults[roundToBePaid].set && roundToBePaid > $.lastRoundPaid && $.totalWinningBetsSet[roundToBePaid]) {
                // checkData.length 3 => batch 0, 4 => batch 1, ...
                uint256 batchIndex = checkData.length - 3;
                uint256 startIndex = batchIndex * BATCH_SIZE;
                
                // ATOMIC CHECK: Only process if this specific batch hasn't been processed yet
                bool batchAlreadyProcessed = ($.roundBatchBitmap[roundToBePaid] & (1 << batchIndex)) != 0;
                
                if ($.jackpotResult[roundToBePaid].jackpotAmount > 0 && startIndex < $.jackpotResult[roundToBePaid].jackpotWinnerCount && !batchAlreadyProcessed) {
                   // Collect addresses and calculate proportional amounts using floor rounding (security: favors protocol)
                   JackpotResult memory jackpotRes = $.jackpotResult[roundToBePaid];
                   IRoulette.PayoutInfo[] memory payouts = _collectJackpotPayoutsBatch(
                       $, 
                       roundToBePaid, 
                       startIndex, 
                       $.randomResults[roundToBePaid].winningNumber,
                       jackpotRes.jackpotAmount,
                       jackpotRes.totalJackpotBetAmount
                   );
                   upkeepNeeded = true;
                   performData = abi.encode(PerformDataPayload({
                        roundId: roundToBePaid,
                        kind: UpkeepKind.JackpotPayoutBatch,
                        payload: abi.encode(JackpotPayoutPayload({
                            payouts: payouts,
                            batchIndex: batchIndex
                        }))
                   }));
                } else if (!batchAlreadyProcessed && startIndex < $.totalWinningBets[roundToBePaid]) {
                    uint256 winningNumber = $.randomResults[roundToBePaid].winningNumber;
                    RouletteLib.WinningBetTypes memory winningTypes = RouletteLib.getWinningBetTypes(winningNumber);
                    // Get winning payouts ONLY for this specific batch range
                    (IRoulette.PayoutInfo[] memory payouts, uint256 totalPayouts) = _collectWinningPayoutsBatch(
                        $, 
                        roundToBePaid, 
                        winningNumber,
                        winningTypes,
                        startIndex
                    );
                    upkeepNeeded = true;
                    performData = abi.encode(PerformDataPayload({
                        roundId: roundToBePaid,
                        kind: UpkeepKind.PayoutBatch,
                        payload: abi.encode(PayoutBatch({
                            totalPayouts: totalPayouts,
                            payouts: payouts,
                            batchIndex: batchIndex
                        }))
                    }));
                }
            }
        }
    }
    
    /**
     * @dev Chainlink Automation: Perform upkeep based on trigger type
     */
    function performUpkeep(bytes calldata performData) external override onlyForwarders {
        PerformDataPayload memory payload = abi.decode(performData, (PerformDataPayload));
        
        if (payload.kind == UpkeepKind.PreVrfLock) {
            IStakedBRB(STAKED_BRB_CONTRACT).onBettingWindowClosed();
        } else if (payload.kind == UpkeepKind.Vrf) {
            _triggerVRF(payload.roundId, abi.decode(payload.payload, (TriggerVRF)));
        } else if (payload.kind == UpkeepKind.ComputeTotalWinningBets) {
            _processComputeTotalWinningBets(payload.roundId, abi.decode(payload.payload, (ComputeTotalWinningBetsData)));
        } else if (payload.kind == UpkeepKind.PayoutBatch) {
            _processBatch(payload.roundId, abi.decode(payload.payload, (PayoutBatch)));
        } else if (payload.kind == UpkeepKind.JackpotPayoutBatch) {
            _processJackpotPayout(payload.roundId, abi.decode(payload.payload, (JackpotPayoutPayload)));
        }
    }
    
    function _triggerVRF(uint256 roundId, TriggerVRF memory triggerData) private {
        RouletteStorage storage $ = _getRouletteStorage();        
        // Update to next round (lastRoundStartTime is updated only after StakedBRB cleaning upkeep)
        $.currentRound = triggerData.newRoundId;
        
        // Request VRF for the round we just finished
        uint256 requestId = vrfCoordinator().requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: tx.gasprice < 2 gwei ? KEY_HASH_2GWEI : tx.gasprice < 30 gwei ? KEY_HASH_30GWEI : KEY_HASH_150GWEI,
                subId: SUBSCRIPTION_ID,
                requestConfirmations: SAFE_BLOCK_CONFIRMATION,
                callbackGasLimit: CALLBACK_GAS_LIMIT,
                numWords: NUMWORDS,
                extraArgs: hex"92fd13380000000000000000000000000000000000000000000000000000000000000000"
            })
        );
        
        $.requestIdToRound[requestId] = roundId;
        
        emit VrfRequested(triggerData.newRoundId, requestId, block.timestamp);

        IStakedBRB(STAKED_BRB_CONTRACT).onRoundTransition(triggerData.newRoundId);
    }

    function _processJackpotPayout(uint256 roundId, JackpotPayoutPayload memory batchJackpotPayout) private {
        RouletteStorage storage $ = _getRouletteStorage();
            // ATOMIC WRITE: Mark this specific batch as processed using bitmap
        $.roundBatchBitmap[roundId] |= (1 << batchJackpotPayout.batchIndex);
        $.winningBetsProcessed[roundId] += batchJackpotPayout.payouts.length;
        
        // Single call to StakedBRB with entire batch
        (bool success, bytes memory returnData) = JACKPOT_CONTRACT.call(
            abi.encodeWithSelector(
                IJackpotContract.jackpotWin.selector,
                batchJackpotPayout.payouts
            )
        );
        
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            } else {
                revert StakedBRBCallFailed();
            }
        }

        if ($.winningBetsProcessed[roundId] == $.jackpotResult[roundId].jackpotWinnerCount) { // isLastBatch
            $.roundBatchBitmap[roundId] = 0;
            $.winningBetsProcessed[roundId] = 0;
            $.jackpotResult[roundId].jackpotAmount = 0; // reset this so it now goes to the other regular wins upkeep loop
        }
    }

    function _processComputeTotalWinningBets(uint256 roundId, ComputeTotalWinningBetsData memory batchData) private {
        RouletteStorage storage $ = _getRouletteStorage();
        $.totalWinningBets[roundId] = batchData.totalWinningBets;
        if (batchData.jackpotWinnerCount > 0) {            
            $.jackpotResult[roundId] = JackpotResult({
                totalJackpotBetAmount: batchData.totalJackpotBetAmount, // Used as denominator
                jackpotWinnerCount: batchData.jackpotWinnerCount,
                jackpotAmount: IERC20(BRB_TOKEN).balanceOf(JACKPOT_CONTRACT) // Used as numerator
            });
            emit JackpotResultEvent(roundId, batchData.jackpotWinnerCount);
        }
        $.totalWinningBetsSet[roundId] = true;

        // special edge case where no winning bets are set
        if (batchData.totalWinningBets == 0) {
            $.lastRoundPaid = roundId;
            IStakedBRB(STAKED_BRB_CONTRACT).processRouletteResult(roundId, new IRoulette.PayoutInfo[](0), 0, true);
            emit RoundResolved(roundId);
        } else {
            emit ComputedPayouts(roundId, batchData.totalWinningBets);
        }
    }
    
    /**
     * @dev Process a batch of users for payout - ULTRA MINIMAL: ONLY WRITES, CALLS, EMITS
     * @dev All computations moved to checkUpkeep for maximum gas efficiency
     */
    function _processBatch(uint256 roundId, PayoutBatch memory batchData) private {
        RouletteStorage storage $ = _getRouletteStorage();
        uint256 payoutLength = batchData.payouts.length;
            // ATOMIC WRITE: Mark this specific batch as processed using bitmap
        $.roundBatchBitmap[roundId] |= (1 << batchData.batchIndex);
        $.winningBetsProcessed[roundId] += payoutLength;
        
        bool isLastBatch = $.winningBetsProcessed[roundId] == $.totalWinningBets[roundId];
        emit BatchProcessed(roundId, batchData.batchIndex + 1, payoutLength);
        // Single call to StakedBRB with entire batch
        IStakedBRB(STAKED_BRB_CONTRACT).processRouletteResult(roundId, batchData.payouts, batchData.totalPayouts, isLastBatch);
        if (isLastBatch) {
            $.lastRoundPaid = roundId;
            emit RoundResolved(roundId);  
        }
    }
    
    /**
     * @dev VRF callback: Resolve previous round
     */
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        RouletteStorage storage $ = _getRouletteStorage();
        
        // Validate request ID exists
        uint256 roundToResolve = $.requestIdToRound[requestId];
        if (roundToResolve == 0) revert InvalidRequestId();
        
        uint256 winningNumber = randomWords[0] % 37; // 0-36
        uint256 jackpotNumber = randomWords[1] % 37; // 0-36

        // Store the VRF result for batch processing
        $.randomResults[roundToResolve] = RandomResult({
            winningNumber: winningNumber,
            jackpotNumber: jackpotNumber,
            set: true
        });
        
        // Cleanup: Remove used request ID (gas refund)
        delete $.requestIdToRound[requestId];
        
        emit VRFResult(roundToResolve, winningNumber, jackpotNumber);
    }
    
    function _collectJackpotPayoutsBatch(
        RouletteStorage storage $,
        uint256 roundId,
        uint256 startIndex,
        uint256 winningNumber,
        uint256 jackpotAmount,
        uint256 totalJackpotBetAmount
    ) private view returns (IRoulette.PayoutInfo[] memory) {
        IRoulette.PayoutInfo[] memory payouts = new IRoulette.PayoutInfo[](BATCH_SIZE);
        uint256 totalLength = $.roundBigStraightBets[roundId][winningNumber].length;
        uint256 j = startIndex;
        uint256 i;
        Bet storage currentBet;
        for (; i < BATCH_SIZE && j < totalLength;) {
            currentBet = $.roundBigStraightBets[roundId][winningNumber][j];
            payouts[i] = IRoulette.PayoutInfo({
                player: currentBet.player,
                payout: currentBet.amount * jackpotAmount / totalJackpotBetAmount
            });
            // Proportional share calculation (Floor Rounding for security)
            // share = (betAmount * jackpotAmount) / totalJackpotBetAmount
            // This ensures we never distribute more than jackpotAmount (floor rounding favors protocol)            
            unchecked { ++i; ++j; }
        }
        assembly {
            mstore(payouts, i)
        }
        return payouts;
    }
    /**
     * @dev Collect winning payouts for a specific batch range (ULTRA OPTIMIZED - NO WASTED ITERATIONS)
     */
    function _collectWinningPayoutsBatch(
        RouletteStorage storage $,
        uint256 roundId,
        uint256 winningNumber,
        RouletteLib.WinningBetTypes memory winningTypes,
        uint256 startIndex
    ) private view returns (IRoulette.PayoutInfo[] memory, uint256) {
        IRoulette.PayoutInfo[] memory tempPayouts = new IRoulette.PayoutInfo[](BATCH_SIZE);
        CollectWinningsValues memory v = CollectWinningsValues({
            payoutCount: 0,
            totalPayouts: 0,
            currentIndex: 0,
            endIndex: startIndex + BATCH_SIZE
        });
        // Process each bet type in order, skipping entire arrays when possible
        
        // 1. STRAIGHT BETS
        (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundBigStraightBets[roundId][winningNumber], 36, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        
        (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundSmallStraightBets[roundId][winningNumber], 36, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);

        // 2. SPLIT BETS
        uint256 j;
        for (; v.payoutCount < BATCH_SIZE && j < winningTypes.winningSplits.length;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundSplitBets[roundId][winningTypes.winningSplits[j]], 18, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 3. STREET BETS
        if (v.payoutCount < BATCH_SIZE && winningTypes.winningStreets > 0) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundStreetBets[roundId][winningTypes.winningStreets], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 4. CORNER BETS  
        for (j = 0; v.payoutCount < BATCH_SIZE && j < winningTypes.winningCorners.length;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundCornerBets[roundId][winningTypes.winningCorners[j]], 9, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 5. LINE BETS
        for (j = 0; v.payoutCount < BATCH_SIZE && j < winningTypes.winningLines.length;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundLineBets[roundId][winningTypes.winningLines[j]], 6, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 6. COLUMN BETS
        if (v.payoutCount < BATCH_SIZE && winningTypes.winningColumn > 0) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundColumnBets[roundId][winningTypes.winningColumn], 3, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 7. DOZEN BETS
        if (v.payoutCount < BATCH_SIZE && winningTypes.winningDozen > 0) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundDozenBets[roundId][winningTypes.winningDozen], 3, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 8. SIMPLE OUTSIDE BETS (1:1 payouts) - use simple function for basic arrays
        if (v.payoutCount < BATCH_SIZE && winningTypes.red) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundRedBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (v.payoutCount < BATCH_SIZE && winningTypes.black) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundBlackBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (v.payoutCount < BATCH_SIZE && winningTypes.odd) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundOddBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (v.payoutCount < BATCH_SIZE && winningTypes.even) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundEvenBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (v.payoutCount < BATCH_SIZE && winningTypes.low) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundLowBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (v.payoutCount < BATCH_SIZE && winningTypes.high) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundHighBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }

        if (v.payoutCount < BATCH_SIZE && winningTypes.trio012) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundTrio012Bets[roundId], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }

        if (v.payoutCount < BATCH_SIZE && winningTypes.trio023) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundTrio023Bets[roundId], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // Resize array to actual payout count
        assembly {
            mstore(tempPayouts, mload(v)) // v.payoutCount is first field of CollectWinningsValues
        }

        return (tempPayouts, v.totalPayouts);
    }
    
    /**
     * @dev Helper for direct storage access with minimal memory usage (ULTRA EFFICIENT)
     */ 
    function _skipOrProcessSimpleBets(
        Bet[] storage bets,
        uint256 multiplier,
        IRoulette.PayoutInfo[] memory tempPayouts,
        uint256 payoutCount,
        uint256 currentIndex,
        uint256 startIndex,
        uint256 endIndex,
        uint256 totalPayouts
    ) private view returns (uint256, uint256, uint256) {
        SkipOrProcessSimpleBetsValues memory v = SkipOrProcessSimpleBetsValues({
            betsLength: bets.length,
            batchStart: startIndex > currentIndex ? startIndex - currentIndex : 0,
            batchEnd: endIndex > currentIndex ? endIndex - currentIndex : 0
        });
        
        
        // Skip entire array if it's completely before our batch
        if (currentIndex + v.betsLength <= startIndex) {
            return (currentIndex + v.betsLength, payoutCount, totalPayouts);
        }
        
        // Calculate exact range - no memory waste
        if (v.batchEnd > v.betsLength) v.batchEnd = v.betsLength;
        
        // Access only needed storage slots
        Bet memory currentBet;
        uint256 payout;
        for (uint256 i = v.batchStart; i < v.batchEnd && payoutCount < tempPayouts.length;) {
            currentBet = bets[i];
            unchecked {
                payout = currentBet.amount * multiplier;
                totalPayouts += payout;
                tempPayouts[payoutCount++] = IRoulette.PayoutInfo({
                player: currentBet.player,
                payout: payout
            });
            ++i;
            }
        }
        
        return (currentIndex + v.betsLength, payoutCount, totalPayouts);
    }
    
    /**
     * @dev Count total winning bets for a round
     * Uses array.length which is O(1) and efficient enough for checkUpkeep's 6.5M gas limit
     * @return totalCount Total number of winning bets
     * @return jackpotWinners Number of jackpot winners (big straight bets on jackpot number)
     * @return totalJackpotBetAmount Total bet amount from jackpot winners (for proportional distribution)
     */
    function _countTotalWinningBets(
        RouletteStorage storage $,
        uint256 roundId,
        uint256 winningNumber,
        uint256 jackpotNumber,
        RouletteLib.WinningBetTypes memory winningTypes
    ) private view returns (uint256 totalCount, uint256 jackpotWinners, uint256 totalJackpotBetAmount) {
        unchecked {
            totalCount = $.roundBigStraightBets[roundId][winningNumber].length;
            // 1. STRAIGHT BETS - array.length is O(1)
            // Check if this winning number also hit the jackpot number
            if (winningNumber == jackpotNumber) {
                jackpotWinners = totalCount;
                // Use pre-computed sum for gas efficiency (already tracked during bet placement)
                totalJackpotBetAmount = $.roundBigStraightBetsSum[roundId][winningNumber];
            }

            totalCount += $.roundSmallStraightBets[roundId][winningNumber].length;
            uint256 j;
            // 2. SPLIT BETS - sum winning split array lengths
            for (; j < winningTypes.winningSplits.length;) {
                totalCount += $.roundSplitBets[roundId][winningTypes.winningSplits[j]].length;
                ++j;
            }

            // 3. STREET BETS - sum winning street array lengths
            if (winningTypes.winningStreets > 0) {
                totalCount += $.roundStreetBets[roundId][winningTypes.winningStreets].length;
            }

            // 4. CORNER BETS - sum winning corner array lengths
            for (j = 0; j < winningTypes.winningCorners.length;) {
                totalCount += $.roundCornerBets[roundId][winningTypes.winningCorners[j]].length;
                ++j;
            }

            // 5. LINE BETS - sum winning line array lengths
            for (j = 0; j < winningTypes.winningLines.length;) {
                totalCount += $.roundLineBets[roundId][winningTypes.winningLines[j]].length;
                ++j;
            }

            // 6. COLUMN BETS - array.length is O(1)
            if (winningTypes.winningColumn > 0) {
                totalCount += $.roundColumnBets[roundId][winningTypes.winningColumn].length;
            }

            // 7. DOZEN BETS - array.length is O(1)
            if (winningTypes.winningDozen > 0) {
                totalCount += $.roundDozenBets[roundId][winningTypes.winningDozen].length;
            }

            // 8. OUTSIDE BETS - array.length is O(1)
            if (winningTypes.red) totalCount += $.roundRedBets[roundId].length;
            if (winningTypes.black) totalCount += $.roundBlackBets[roundId].length;
            if (winningTypes.odd) totalCount += $.roundOddBets[roundId].length;
            if (winningTypes.even) totalCount += $.roundEvenBets[roundId].length;
            if (winningTypes.low) totalCount += $.roundLowBets[roundId].length;
            if (winningTypes.high) totalCount += $.roundHighBets[roundId].length;

            // 9. EUROPEAN SECTION BETS - array.length is O(1)
            if (winningTypes.trio012) totalCount += $.roundTrio012Bets[roundId].length;
            if (winningTypes.trio023) totalCount += $.roundTrio023Bets[roundId].length;
            // Removed voisins, tiers, orphelins as they are no longer supported
        }
    }

    function _isBettingOpen() private view returns (bool) {
        if (IStakedBRB(STAKED_BRB_CONTRACT).roundTransitionInProgress()) return false;
        // Keep betting-open gating aligned with the same boundary timestamp
        // used for GAME_PERIOD / no-bet lock calculations.
        uint256 srt = IStakedBRB(STAKED_BRB_CONTRACT).lastRoundBoundaryTimestamp();
        uint256 elapsed = block.timestamp - srt;
        return elapsed < GAME_PERIOD;
    }

    /// @inheritdoc IRoulette
    function isBettingOpen() external view override returns (bool) {
        return _isBettingOpen();
    }

    /// @inheritdoc IRoulette
    function gamePeriod() external view override returns (uint256) {
        return GAME_PERIOD;
    }

    /// @inheritdoc IRoulette
    function onRoundBoundary(uint256 boundaryTimestamp) external override onlyStakedBRBContract {
        _getRouletteStorage().lastRoundStartTime = boundaryTimestamp;
    }

    // ========== VIEW FUNCTIONS ==========
    
    /**
     * @dev Get upkeep configuration and bet limits
     */
    function getUpkeepConfig() external view returns (uint256, uint256, uint256, uint32) {
        IBRBUpkeepManager m = IBRBUpkeepManager(UPKEEP_MANAGER);
        return (
            m.maxSupportedBets(),
            m.registeredPayoutUpkeepCount(),
            m.batchSize(),
            m.upkeepGasLimit()
        );
    }
    
    /**
     * @dev Check if more bets can be placed in current round
     */
    function canPlaceBets(uint256 additionalBets) external view returns (bool) {
        RouletteStorage storage $ = _getRouletteStorage();
        uint256 currentBets = $.totalBetsInRound[$.currentRound];
        return (currentBets + additionalBets) <= IBRBUpkeepManager(UPKEEP_MANAGER).maxSupportedBets();
    }
    
    /**
     * @dev Get current round info
     */
    function getCurrentRoundInfo() external view returns (
        uint256 currentRound,
        uint256 lastRoundStartTime,
        uint256 lastRoundPaid
    ) {
        RouletteStorage storage $ = _getRouletteStorage();
        return ($.currentRound, $.lastRoundStartTime, $.lastRoundPaid);
    }

    /**
     * @dev Get contract constants (min no-bet lock seconds, batch size, game period, payout upkeep gas limit).
     *      Max lock is NO_BET_LOCK_MIN + NO_BET_LOCK_MOD - 1 (10); duration uses lastRoundStartTime % NO_BET_LOCK_MOD.
     */
    function getConstants() external view returns (uint256, uint256, uint256, uint32) {
        return (NO_BET_LOCK_MIN, BATCH_SIZE, GAME_PERIOD, UPKEEP_GAS_LIMIT);
    }

    /**
     * @dev Get round VRF result
     */
    function getRoundResult(uint256 roundId) external view returns (RandomResult memory) {
        return _getRouletteStorage().randomResults[roundId];
    }
    
    /**
     * @dev Get round bets count
     */
    function getRoundBetsCount(uint256 roundId) external view returns (uint256) {
        return _getRouletteStorage().totalBetsInRound[roundId];
    }

    function getChainlinkConfig() external view returns (uint256, bytes32, bytes32, bytes32, uint32, uint32, uint16) {
        return (SUBSCRIPTION_ID, KEY_HASH_2GWEI, KEY_HASH_30GWEI, KEY_HASH_150GWEI, CALLBACK_GAS_LIMIT, NUMWORDS, SAFE_BLOCK_CONFIRMATION);
    }
    
    /**
     * @dev Seconds until VRF can fire (after GAME_PERIOD + no-bet lock). Returns 0 in the trigger window,
     *      type(uint256).max while StakedBRB round transition is in progress.
     */
    function getSecondsFromNextUpkeepWindow() external view returns (uint256) {
        if (IStakedBRB(STAKED_BRB_CONTRACT).roundTransitionInProgress()) {
            return type(uint256).max;
        }
        uint256 srt = IStakedBRB(STAKED_BRB_CONTRACT).lastRoundBoundaryTimestamp();
        uint256 elapsed = block.timestamp - srt;
        uint256 lockDuration = NO_BET_LOCK_MIN + (srt % NO_BET_LOCK_MOD);
        uint256 vrfDeadline = GAME_PERIOD + lockDuration;

        if (elapsed < GAME_PERIOD) {
            return GAME_PERIOD - elapsed;
        }
        if (!IStakedBRB(STAKED_BRB_CONTRACT).roundResolutionLocked()) {
            return 0;
        }
        if (elapsed < vrfDeadline) {
            return vrfDeadline - elapsed;
        }
        return 0;
    }
    
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}