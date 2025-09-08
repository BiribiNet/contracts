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
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IAutomationRegistrar2_1 } from "./interfaces/IAutomationRegistrar2_1.sol";
import { IAutomationRegistry2_1 } from "./interfaces/IAutomationRegistry2_1.sol";

/**
 * @title RouletteClean
 * @dev SIMPLE roulette contract - easy to understand
 */
contract RouletteClean is AccessControlUpgradeable, VRFConsumerBaseV2, UUPSUpgradeable, AutomationCompatibleInterface {
    
    // ========== SIMPLE CONSTANTS ==========
    uint256 private constant TIME_MARGIN = 10; // 10 seconds
    uint32 private constant BATCH_SIZE = 10; // Users per batch for payout processing
    
    // GAS LIMIT CALCULATION FOR WORST-CASE SCENARIO (all bets win)
    uint32 private constant BASE_GAS_OVERHEAD = 100000; // Base transaction overhead
    uint32 private constant GAS_PER_WINNING_BET = 50000; // Gas per winning bet payout (transfer + events)
    uint32 private constant MAX_GAS_LIMIT = 5000000; // Conservative limit under Chainlink's default 10M
    
    // CALCULATED GAS LIMIT: Covers BATCH_SIZE winning bets + overhead
    uint32 private constant UPKEEP_GAS_LIMIT = BASE_GAS_OVERHEAD + (BATCH_SIZE * GAS_PER_WINNING_BET);
    uint256 private immutable GAME_PERIOD; // e.g., 60 seconds per round
    
    // EIP-7201 storage location
    // keccak256(abi.encode(uint256(keccak256("roulette.storage.main")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MAIN_STORAGE_LOCATION = 0xd1b0e7e1fbb7c3a5f2d4c6e8b9a1c3e5f7b9d1e3f5a7c9e1f3b5d7e9f1a3c500;
    
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

    struct ComputeTotalWinningBetsData {
        uint256 totalWinningBets;
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
        // CHAINLINK AUTOMATION SETUP
        mapping(address => uint256) forwarders; // forwarder => upkeepId
        address keeperRegistrar;
        address keeperRegistry;
        address linkToken;
        
        // UPKEEP MANAGEMENT
        uint256 maxSupportedBets; // Maximum number of bets supported across all registered upkeeps
        uint256 registeredUpkeepCount; // Number of payout upkeeps registered (excluding VRF upkeep)
        
        // EFFICIENT BET STORAGE BY TYPE (like casino dealer sections)
        mapping(uint256 => mapping(uint256 => Bet[])) roundStraightBets;   // roundId => number => straight bets
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
        
        // EUROPEAN SECTION BETS
        // ... existing code ...

        mapping(uint256 => RandomResult) randomResults; // roundId => VRF result
        mapping(uint256 => uint256) requestIdToRound; // VRF request => round
    }
    
    // ========== UPKEEP STRUCTS ==========
    struct RandomResult {
        uint256 randomWord;
        bool set; // Whether VRF result is available
    }
    
    struct PerformDataPayload {
        uint256 roundId;
        uint256 upkeepType; // 0 = VRF trigger, 1 = compute total winning bets, 2 = payout users
        bytes payload;
    }
    
    struct TriggerVRF {
        uint256 newLastRoundStartTimestamp;
        uint256 newRoundId;
    }
    
    struct PayoutInfo {
        address player;
        uint256 betAmount;
        uint256 payout;
    }
    
    struct PayoutBatch {
        uint256 totalPayouts;
        PayoutInfo[] payouts; // Pre-computed payouts for this batch
        uint256 batchIndex; // Pre-computed batch index
    }
    
    struct WinningBetTypes {
        // INSIDE BETS
        uint256[] winningSplits;    // Split IDs that win
        uint256 winningStreets;   // Street numbers that win  
        uint256[] winningCorners;   // Corner IDs that win
        uint256[] winningLines;     // Line IDs that win
        
        // OUTSIDE BETS
        uint256 winningColumn;      // Column (1, 2, or 3) - 0 if none
        uint256 winningDozen;       // Dozen (1, 2, or 3) - 0 if none
        bool red;
        bool black; 
        bool odd;
        bool even;
        bool low;   // 1-18
        bool high;  // 19-36
        bool trio012; // Trio 0-1-2
        bool trio023; // Trio 0-2-3
    }
    struct CollectWinningsValues {
        uint256 payoutCount;
        uint256 totalPayouts;
        uint256 currentIndex;
        uint256 endIndex;
    }

    struct SkipOrProcessSimpleBetsValues {
        uint256 betsLength;
        uint256 rangeStart;
        uint256 rangeEnd;
    }
    
    function _getRouletteStorage() private pure returns (RouletteStorage storage $) {
        assembly {
            $.slot := MAIN_STORAGE_LOCATION
        }
    }
    
    // ========== COMPLETE BET STRUCTURE ==========
    struct Bet {
        address player;
        uint256 amount;
        uint256 betType; // See BET_TYPES constants below
        uint256 number; // Primary number/identifier for the bet
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
    
    // ========== MULTIPLE BETS STRUCTURE ==========
    struct MultipleBets {
        uint256[] amounts;   // Array of bet amounts
        uint256[] betTypes;  // Array of bet types
        uint256[] numbers;   // Array of numbers (0 for non-straight bets)
    }
    
    // ========== EVENTS ==========
    event BetPlaced(address player, uint256 amount, uint256 betType, uint256 number);
    event RoundStarted(uint256 roundId, uint256 timestamp, uint256 requestId);
    event RoundResolved(uint256 roundId);
    event VRFResult(uint256 roundId, uint256 winningNumber);
    event BatchProcessed(uint256 roundId, uint256 batchIndex, uint256 payoutsCount);
    event ChainlinkSetupCompleted(uint256 subscriptionId, address keeperRegistrar, address keeperRegistry);
    event UpkeepRegistered(uint256 upkeepId, address forwarder, uint32 gasLimit, uint96 linkAmount, uint256 checkDataLength, string upkeepType);
    event MaxSupportedBetsUpdated(uint256 maxSupportedBets, uint256 totalUpkeeps);
    
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
    error UpkeepRegistrationFailed();
    error BetLimitExceeded();
    error TransferFailed();
    error InvalidRoundId();
    
    constructor(
        uint256 gamePeriod,
        address vrfCoordinator,
        bytes32 keyHash2Gwei,
        bytes32 keyHash30Gwei,
        bytes32 keyHash150Gwei,
        uint256 subscriptionId,
        uint32 callbackGasLimit,
        uint32 numWords,
        uint16 safeBlockConfirmation,
        address stakedBRBContract
    ) VRFConsumerBaseV2(vrfCoordinator) {
        GAME_PERIOD = gamePeriod;
        KEY_HASH_2GWEI = keyHash2Gwei;
        KEY_HASH_30GWEI = keyHash30Gwei;
        KEY_HASH_150GWEI = keyHash150Gwei;
        SUBSCRIPTION_ID = subscriptionId;
        CALLBACK_GAS_LIMIT = callbackGasLimit;
        NUMWORDS = numWords;
        SAFE_BLOCK_CONFIRMATION = safeBlockConfirmation;
        STAKED_BRB_CONTRACT = stakedBRBContract;
        _disableInitializers();
    }
    
    function initialize(
        address admin,
        address keeperRegistrar,
        address keeperRegistry,
        address linkToken
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        
        if (keeperRegistrar == address(0) || keeperRegistry == address(0) || linkToken == address(0)) {
            revert ZeroAddress();
        }
        
        RouletteStorage storage $ = _getRouletteStorage();
        $.currentRound = 1;
        $.lastRoundStartTime = block.timestamp;
        
        // Store Keeper addresses
        $.keeperRegistrar = keeperRegistrar;
        $.keeperRegistry = keeperRegistry;
        $.linkToken = linkToken;
        
        // Approve LINK for upkeep registration
        IERC20(linkToken).approve(keeperRegistrar, type(uint256).max);
        
        emit ChainlinkSetupCompleted(SUBSCRIPTION_ID, keeperRegistrar, keeperRegistry);
    }
    
    // ========== MODIFIERS ==========
    
    /**
     * @dev Only allows calls from registered Chainlink forwarders
     */
    modifier onlyForwarders() {
        RouletteStorage storage $ = _getRouletteStorage();
        if ($.forwarders[msg.sender] == 0) revert OnlyForwarders();
        _;
    }
    
    // ========== CHAINLINK SETUP FUNCTIONS ==========
    
    /**
     * @dev Register VRF trigger upkeep (admin only)
     * @param linkAmount Amount of LINK to fund the upkeep (18 decimals)
     */
    function registerVRFUpkeep(
        uint96 linkAmount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256) {
        RouletteStorage storage $ = _getRouletteStorage();
        if ($.keeperRegistrar == address(0)) revert ZeroAddress();
        
        // Transfer LINK from caller to this contract for upkeep funding
        IERC20($.linkToken).transferFrom(msg.sender, address(this), linkAmount);
        
        string memory upkeepName = string.concat(
            "RouletteClean-VRF-",
            Strings.toHexString(address(this))
        );
        
        uint256 upkeepId = IAutomationRegistrar2_1($.keeperRegistrar).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: address(this),
                gasLimit: UPKEEP_GAS_LIMIT, // Use calculated gas limit
                adminAddress: msg.sender,
                triggerType: 0, // Conditional trigger
                checkData: new bytes(0), // Empty = VRF trigger
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );
        
        if (upkeepId == 0) revert UpkeepRegistrationFailed();
        
        // Get forwarder address and register it
        address forwarder = IAutomationRegistry2_1($.keeperRegistry).getForwarder(upkeepId);
        $.forwarders[forwarder] = upkeepId;
        
        emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmount, 0, "VRF");
        return upkeepId;
    }
    
    function registerComputeTotalWinningBetsUpkeep(
        uint96 linkAmount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256) {
        RouletteStorage storage $ = _getRouletteStorage();
        if ($.keeperRegistrar == address(0)) revert ZeroAddress();
        
        string memory upkeepName = string.concat(
            "RouletteClean-ComputeTotalWinningBets-",
            Strings.toHexString(address(this))
        );

        IERC20($.linkToken).transferFrom(msg.sender, address(this), linkAmount);
        
        uint256 upkeepId = IAutomationRegistrar2_1($.keeperRegistrar).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: address(this),
                gasLimit: UPKEEP_GAS_LIMIT, // Use calculated gas limit
                adminAddress: msg.sender,
                triggerType: 0, // Conditional trigger
                checkData: new bytes(1),
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert UpkeepRegistrationFailed();
        
        // Get forwarder address and register it
        address forwarder = IAutomationRegistry2_1($.keeperRegistry).getForwarder(upkeepId);
        $.forwarders[forwarder] = upkeepId;
        
        emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmount, 1, "COMPUTE_TOTAL_WINNING_BETS");
        return upkeepId;
    }
    /**
     * @dev Register multiple payout upkeeps to support higher bet volumes (admin only)
     * @param upkeepCount Number of payout upkeeps to register
     * @param linkAmountPerUpkeep Amount of LINK to fund each upkeep (18 decimals)
     */
    function registerPayoutUpkeeps(
        uint256 upkeepCount,
        uint96 linkAmountPerUpkeep
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256[] memory) {
        RouletteStorage storage $ = _getRouletteStorage();
        if ($.keeperRegistrar == address(0)) revert ZeroAddress();
        if (upkeepCount == 0) revert ZeroAmount();
        
        // Transfer total LINK amount needed from caller to this contract
        uint256 totalLinkNeeded = upkeepCount * linkAmountPerUpkeep;
        IERC20($.linkToken).transferFrom(msg.sender, address(this), totalLinkNeeded);
        
        uint256[] memory upkeepIds = new uint256[](upkeepCount);
        
        bytes memory checkData;
        uint256 checkDataLength;
        string memory upkeepName;
        uint256 upkeepId;
        address forwarder;
        for (uint256 i; i < upkeepCount;) {
            // checkData.length determines batch range: length 1 = batch 0, length 2 = batch 1, etc.
            checkData = new bytes(i + 2);
            checkDataLength = checkData.length;
            
            upkeepName = string.concat(
                "RouletteClean-Payout-",
                Strings.toString(checkDataLength),
                "-",
                Strings.toHexString(address(this))
            );
            
            upkeepId = IAutomationRegistrar2_1($.keeperRegistrar).registerUpkeep(
                IAutomationRegistrar2_1.RegistrationParams({
                    name: upkeepName,
                    encryptedEmail: new bytes(0),
                    upkeepContract: address(this),
                    gasLimit: UPKEEP_GAS_LIMIT, // Use calculated gas limit
                    adminAddress: msg.sender,
                    triggerType: 0, // Conditional trigger
                    checkData: checkData, // Length determines batch index
                    triggerConfig: new bytes(0),
                    offchainConfig: new bytes(0),
                    amount: linkAmountPerUpkeep
                })
            );
            
            if (upkeepId == 0) revert UpkeepRegistrationFailed();
            
            // Get forwarder address and register it
            forwarder = IAutomationRegistry2_1($.keeperRegistry).getForwarder(upkeepId);
            $.forwarders[forwarder] = upkeepId;
            
            upkeepIds[i] = upkeepId;
            
            emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmountPerUpkeep, checkDataLength, "PAYOUT");
            
            unchecked { ++i; }
        }
        
        // Update tracking variables
        $.registeredUpkeepCount += upkeepCount;
        $.maxSupportedBets = $.registeredUpkeepCount * BATCH_SIZE;
        
        emit MaxSupportedBetsUpdated($.maxSupportedBets, $.registeredUpkeepCount);
        
        return upkeepIds;
    }
    
    /**
     * @dev Called when user places bet(s) - supports multiple bets in one call
     * @param sender Who placed the bet
     * @param totalValue Total amount bet (in wei) across all bets
     * @param data Bet data: abi.encode(MultipleBets) OR abi.encode(betType, number) for single bet
     */
    function bet(address sender, uint256 totalValue, bytes calldata data) 
        external returns (uint256)
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
    function _processMultipleBets(address sender, uint256 totalValue, MultipleBets memory bets, RouletteStorage storage $) private returns (uint256 maxPayout) {
        uint256 betsLength = bets.amounts.length; // Cache array length
        
        // Validate arrays have same length
        if (betsLength != bets.betTypes.length || betsLength != bets.numbers.length) {
            revert ArrayLengthMismatch();
        }
        
        if (betsLength == 0) revert EmptyBetsArray();
        
        // Cache storage reads
        uint256 currentRound = $.currentRound;
        
        uint256 newTotalBets = $.totalBetsInRound[currentRound] + betsLength;
        if (newTotalBets > $.maxSupportedBets) {
            revert BetLimitExceeded();
        }
        
        // SINGLE LOOP: Validate total AND process bets in one pass
        uint256 calculatedTotal;
        uint256 amount;
        for (uint256 i; i < betsLength;) {
            amount = bets.amounts[i];
            calculatedTotal += amount;
            
            // Validate and store bet
            maxPayout += _validateAndStoreBet(
                sender,
                amount,
                bets.betTypes[i],
                bets.numbers[i],
                currentRound,
                $
            );
            
            unchecked { ++i; }
        }

        // Validate total amount matches
        if (calculatedTotal != totalValue) revert InvalidBet();
        
        $.totalBetsInRound[currentRound] = newTotalBets;

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
        RouletteStorage storage $
    ) private returns (uint256 payout) {
        // Validate bet amount
        if (amount == 0 || amount < 1000) revert ZeroAmount(); // Minimum 1000 wei per bet
        if (amount > 1000 ether) revert InvalidBet(); // Maximum 1000 BRB (1000 * 10**18 wei) per bet
        
        // Validate bet type
        if (betType == 0 || betType > BET_TRIO_023) revert InvalidBetType();
        
        // Store the bet in appropriate mapping for efficient lookup
        Bet memory newBet = Bet({
            player: sender,
            amount: amount,
            betType: betType,
            number: number
        });
        
        unchecked {
            // DEALER-STYLE STORAGE: Each bet type goes to its specific section (using cached currentRound)
            if (betType == BET_STRAIGHT) {
                if (number > 36) revert InvalidNumber();
                payout = amount * 36;
                $.roundStraightBets[currentRound][number].push(newBet);
            } else if (betType == BET_SPLIT) {
                if (!isValidSplit(number)) revert InvalidNumber();
                payout = amount * 18;
                $.roundSplitBets[currentRound][number].push(newBet);
            } else if (betType == BET_STREET) {
                if (number == 0 || number > 34 || (number - 1) % 3 != 0) revert InvalidNumber();
                payout = amount * 12;
                $.roundStreetBets[currentRound][number].push(newBet);
            } else if (betType == BET_CORNER) {
                if (!isValidCorner(number)) revert InvalidNumber();
                payout = amount * 9;
                $.roundCornerBets[currentRound][number].push(newBet);
            } else if (betType == BET_LINE) {
                if (number == 0 || number > 31 || (number - 1) % 3 != 0) revert InvalidNumber();
                payout = amount * 6;
                $.roundLineBets[currentRound][number].push(newBet);
            } else if (betType == BET_COLUMN) {
                if (number == 0 || number > 3) revert InvalidNumber();
                payout = amount * 3;
                $.roundColumnBets[currentRound][number].push(newBet);
            } else if (betType == BET_DOZEN) {
                if (number == 0 || number > 3) revert InvalidNumber();
                payout = amount * 3;
                $.roundDozenBets[currentRound][number].push(newBet);
            } else if (betType == BET_RED) {
                payout = amount * 2;
                $.roundRedBets[currentRound].push(newBet);
            } else if (betType == BET_BLACK) {
                payout = amount * 2;
                $.roundBlackBets[currentRound].push(newBet);
            } else if (betType == BET_ODD) {
                payout = amount * 2;
                $.roundOddBets[currentRound].push(newBet);
            } else if (betType == BET_EVEN) {
                payout = amount * 2;
                $.roundEvenBets[currentRound].push(newBet);
            } else if (betType == BET_LOW) {
                payout = amount * 2;
                $.roundLowBets[currentRound].push(newBet);
            } else if (betType == BET_HIGH) {
                payout = amount * 2;
                $.roundHighBets[currentRound].push(newBet);
            } else if (betType == BET_TRIO_012) {
                payout = amount * 12;
                $.roundTrio012Bets[currentRound].push(newBet);
            } else if (betType == BET_TRIO_023) {
                payout = amount * 12;
                $.roundTrio023Bets[currentRound].push(newBet);
            }
        }
    }
    
    /**
     * @dev Chainlink Automation: Check if upkeep needed
     * @param checkData Empty for VRF trigger, length determines user batch range for payouts
     * 
     * SEQUENTIAL SAFETY: This function ensures batches are processed in order to prevent
     * parallel execution issues. Batch N can only be processed if batch N-1 is completed.
     * This prevents race conditions where multiple upkeeps could process overlapping batches.
     */
    function checkUpkeep(bytes calldata checkData) external view override returns (bool upkeepNeeded, bytes memory performData) {
        RouletteStorage storage $ = _getRouletteStorage();
        
        if (checkData.length == 0) {
            // VRF TRIGGER: Check if we need to start new round and request VRF
            uint256 srt = $.lastRoundStartTime;
            uint256 elapsed = block.timestamp - srt;
            uint256 remainder = elapsed % GAME_PERIOD;
            uint256 currentRound = $.currentRound;

            // Only allow upkeep if we have bets and we are within the TIME_MARGIN window
            upkeepNeeded = $.totalBetsInRound[currentRound] > 0 && (elapsed >= GAME_PERIOD && remainder <= TIME_MARGIN);

            if (upkeepNeeded) {
                // Calculate the next scheduled start timestamp
                performData = abi.encode(PerformDataPayload({
                    roundId: currentRound,
                    upkeepType: 0,
                    payload: abi.encode(TriggerVRF({
                        newLastRoundStartTimestamp: srt + (elapsed / GAME_PERIOD) * GAME_PERIOD,
                        newRoundId: currentRound + 1
                    }))
                }));
            }

        } else if (checkData.length == 1) {
            // COMPUTE TOTAL WINNING BETS: Check if we need to compute total winning bets
             uint256 roundToBePaid = $.lastRoundPaid + 1;
             if (roundToBePaid < $.currentRound && $.randomResults[roundToBePaid].set && roundToBePaid > $.lastRoundPaid && !$.totalWinningBetsSet[roundToBePaid]) {
                uint256 totalWinningBets = _countTotalWinningBets($, roundToBePaid, $.randomResults[roundToBePaid].randomWord, _getWinningBetTypes($.randomResults[roundToBePaid].randomWord));
                upkeepNeeded = true;
                performData = abi.encode(PerformDataPayload({
                    roundId: roundToBePaid,
                    upkeepType: 1,
                    payload: abi.encode(ComputeTotalWinningBetsData({
                        totalWinningBets: totalWinningBets
                    }))
                }));
             }

        } else {
            // PAYOUT USERS: Check if we need to pay users from completed rounds
            uint256 roundToBePaid = $.lastRoundPaid + 1;
            
            // Only process if round exists and has VRF result (check lastRoundPaid instead of roundResolved)
            if (roundToBePaid < $.currentRound && $.randomResults[roundToBePaid].set && roundToBePaid > $.lastRoundPaid && $.totalWinningBetsSet[roundToBePaid]) {
                // Calculate batch range based on checkData.length
                // checkData.length == 1: batch 0 (users 0-9)
                // checkData.length == 2: batch 1 (users 10-19)
                // checkData.length == n: batch n-1
                
                uint256 batchIndex = checkData.length - 2; // 0 is for VRF and 1 is for COMPUTE TOTAL WINNING BETS
                uint256 startIndex = batchIndex * BATCH_SIZE;
                
                // ATOMIC CHECK: Only process if this specific batch hasn't been processed yet
                uint256 batchBitmap = $.roundBatchBitmap[roundToBePaid];
                bool batchAlreadyProcessed = (batchBitmap & (1 << batchIndex)) != 0;
                
                // Only proceed if this batch can be processed
                if (!batchAlreadyProcessed && startIndex < $.totalWinningBets[roundToBePaid]) {
                    uint256 winningNumber = $.randomResults[roundToBePaid].randomWord;
                    WinningBetTypes memory winningTypes = _getWinningBetTypes(winningNumber);
                    
                    // Get winning payouts ONLY for this specific batch range
                    (PayoutInfo[] memory payouts, uint256 totalPayouts) = _collectWinningPayoutsBatch(
                        $, 
                        roundToBePaid, 
                        winningNumber, 
                        winningTypes,
                        startIndex,
                        BATCH_SIZE
                    );
                    
                    upkeepNeeded = true;
                    performData = abi.encode(PerformDataPayload({
                        roundId: roundToBePaid,
                        upkeepType: 2,
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
        
        if (payload.upkeepType == 0) {
            // VRF TRIGGER: Start new round and request VRF
            TriggerVRF memory triggerData = abi.decode(payload.payload, (TriggerVRF));
            _triggerVRF(payload.roundId, triggerData);
        } else if (payload.upkeepType == 1) {
            // COMPUTE TOTAL WINNING BETS: Process batch of users for a round
            ComputeTotalWinningBetsData memory batchData = abi.decode(payload.payload, (ComputeTotalWinningBetsData));
            _processComputeTotalWinningBets(payload.roundId, batchData);
        } else if (payload.upkeepType == 2) {
            // PAYOUT USERS: Process batch of users for a round
            PayoutBatch memory batchData = abi.decode(payload.payload, (PayoutBatch));
            _processBatch(payload.roundId, batchData);
        }
    }
    
    function _triggerVRF(uint256 roundId, TriggerVRF memory triggerData) private {
        RouletteStorage storage $ = _getRouletteStorage();        
        // Update to next round
        $.currentRound = triggerData.newRoundId;
        $.lastRoundStartTime = triggerData.newLastRoundStartTimestamp;
        
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
        
        emit RoundStarted(triggerData.newRoundId, triggerData.newLastRoundStartTimestamp, requestId);

        IStakedBRB(STAKED_BRB_CONTRACT).onRoundTransition(triggerData.newRoundId, roundId);
    }

    function _processComputeTotalWinningBets(uint256 roundId, ComputeTotalWinningBetsData memory batchData) private {
        RouletteStorage storage $ = _getRouletteStorage();
        $.totalWinningBets[roundId] = batchData.totalWinningBets;
        $.totalWinningBetsSet[roundId] = true;

        // special edge case where no winning bets are set
        if (batchData.totalWinningBets == 0) {
            $.lastRoundPaid = roundId;
            emit RoundResolved(roundId);

            (bool success, bytes memory returnData) = STAKED_BRB_CONTRACT.call(
                abi.encodeWithSelector(
                    IStakedBRB.processRouletteResult.selector,
                    roundId,
                    new PayoutInfo[](0),
                    0,
                    true
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
        if (isLastBatch) {
            $.lastRoundPaid = roundId;
            emit RoundResolved(roundId);
            
        }

        // Single call to StakedBRB with entire batch
        (bool success, bytes memory returnData) = STAKED_BRB_CONTRACT.call(
            abi.encodeWithSelector(
                IStakedBRB.processRouletteResult.selector,
                roundId,
                batchData.payouts,
                batchData.totalPayouts,
                isLastBatch
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
        
        // Store the VRF result for batch processing
        $.randomResults[roundToResolve] = RandomResult({
            randomWord: winningNumber,
            set: true
        });
        
        // Cleanup: Remove used request ID (gas refund)
        delete $.requestIdToRound[requestId];
        
        emit VRFResult(roundToResolve, winningNumber);
    }
    
    /**
     * @dev Determine ALL winning bet sections for a given number (COMPLETE CASINO DEALER LOGIC)
     */
    function _getWinningBetTypes(uint256 winningNumber) private pure returns (WinningBetTypes memory) {
        WinningBetTypes memory winning;
        
        // OUTSIDE BETS (simple)
        winning.red = _isRedNumber(winningNumber);
        winning.black = !_isRedNumber(winningNumber) && winningNumber != 0;
        winning.odd = winningNumber > 0 && winningNumber % 2 == 1;
        winning.even = winningNumber > 0 && winningNumber % 2 == 0;
        winning.low = winningNumber >= 1 && winningNumber <= 18;
        winning.high = winningNumber >= 19 && winningNumber <= 36;
        
        // COLUMN & DOZEN (if not zero)
        if (winningNumber > 0) {
            winning.winningColumn = ((winningNumber - 1) % 3) + 1; // 1, 2, or 3
            winning.winningDozen = ((winningNumber - 1) / 12) + 1;  // 1, 2, or 3
        }
        
        // EUROPEAN SECTIONS
        // winning.voisins = _isVoisinsNumber(winningNumber); // Removed
        // winning.tiers = _isTiersNumber(winningNumber); // Removed
        // winning.orphelins = _isOrphelinsNumber(winningNumber); // Removed
        winning.trio012 = _isTrio012Number(winningNumber);
        winning.trio023 = _isTrio023Number(winningNumber);
        
        // INSIDE BETS (complex - determine which splits, streets, corners, lines win)
        winning.winningSplits = _getWinningSplits(winningNumber);
        winning.winningStreets = _getWinningStreets(winningNumber);
        winning.winningCorners = _getWinningCorners(winningNumber);
        winning.winningLines = _getWinningLines(winningNumber);
        
        return winning;
    }
    
    /**
     * @dev Get all splits that include this number
     */
    function _getWinningSplits(uint256 num) private pure returns (uint256[] memory) {
        uint256[] memory splits = new uint256[](10); // Max 4 splits per number
        uint256 count;
        
        if (num == 0) return new uint256[](0); // Zero has no splits
        
        // Horizontal splits (left-right)
        if (num % 3 != 0 && num < 36) splits[count++] = _getSplitId(num, num + 1);
        if (num % 3 != 1 && num > 1) splits[count++] = _getSplitId(num - 1, num);
        
        // Vertical splits (up-down)  
        if (num <= 33) splits[count++] = _getSplitId(num, num + 3);
        if (num >= 4) splits[count++] = _getSplitId(num - 3, num);
        
        // Use assembly to resize array instead of copying
        assembly {
            mstore(splits, count)
        }
        return splits;
    }
    
    /**
     * @dev Get street number for this number
     */
    function _getWinningStreets(uint256 num) private pure returns (uint256) {
        if (num == 0) return 0; // Zero has no standard street
        
        return ((num - 1) / 3) * 3 + 1; // First number of the street
    }
    
    /**
     * @dev Get all corners that include this number
     */
    function _getWinningCorners(uint256 num) private pure returns (uint256[] memory) {
        uint256[] memory corners = new uint256[](4);
        uint256 count;
        
        // Special case: 0-1-2-3 corner (corner ID 0)
        if (num == 0 || num == 1 || num == 2 || num == 3) {
            corners[count++] = 0; // Special 0-1-2-3 corner
        }
        
        // For numbers 1-36, find all valid 2x2 corners that contain this number
        // Corner ID = top-left number of the 2x2 square
        
        if (num >= 1 && num <= 36) {
            // Top-left corner (num is bottom-right of 2x2 square)
            // Example: num=5, corner is 1-2-4-5, so corner ID = 1
            if (num >= 4 && num <= 36 && (num - 1) % 3 != 0) {
                corners[count++] = num - 4; // Top-left of corner
            }
            
            // Top-right corner (num is bottom-left of 2x2 square)  
            // Example: num=5, corner is 2-3-5-6, so corner ID = 2
            if (num >= 4 && num <= 36 && num % 3 != 0) {
                corners[count++] = num - 3; // Top-left of corner
            }
            
            // Bottom-left corner (num is top-right of 2x2 square)
            // Example: num=5, corner is 4-5-7-8, so corner ID = 4
            if (num >= 1 && num <= 33 && (num - 1) % 3 != 0) {
                corners[count++] = num - 1; // Top-left of corner
            }
            
            // Bottom-right corner (num is top-left of 2x2 square)
            // Example: num=5, corner is 5-6-8-9, so corner ID = 5
            if (num >= 1 && num <= 33 && num % 3 != 0) {
                corners[count++] = num; // Top-left of corner
            }
        }
        
        // Use assembly to resize array instead of copying
        assembly {
            mstore(corners, count)
        }
        return corners;
    }
    
    /**
     * @dev Get lines that include this number  
     */
    function _getWinningLines(uint256 num) private pure returns (uint256[] memory) {
        if (num == 0) return new uint256[](0);
        
        uint256[] memory lines = new uint256[](2); // Max 2 lines per number
        uint256 count;                               
        uint256 streetStart = ((num - 1) / 3) * 3 + 1; // First number of the street num is in
        
        // Line that starts with the current street (e.g., if num is 4, this is 4-9 line)
        if (streetStart <= 31) { // Line must not go beyond number 36 (31,32,33,34,35,36 is last line) 
            lines[count++] = streetStart;
        }
        
        // Line that ends with the current street (e.g., if num is 4, this is 1-6 line)
        if (streetStart > 1 && (streetStart - 3) >= 1) { // Line must not start before 1 (1,2,3,4,5,6 is first line)
            lines[count++] = streetStart - 3; // Line starts at the first number of the previous street
        }

        // Use assembly to resize array to actual size
        assembly {
            mstore(lines, count)
        }
        return lines;
    }
    
    /**
     * @dev Generate split ID for two numbers
     */
    function _getSplitId(uint256 num1, uint256 num2) private pure returns (uint256) {
        return num1 < num2 ? num1 * 100 + num2 : num2 * 100 + num1;
    }
    
    /**
     * @dev Validate if a split ID represents a valid adjacent pair of numbers
     */
    function isValidSplit(uint256 splitId) private pure returns (bool) {
        if (splitId < 100) return false; // Minimum valid split ID is 102 (1-2)
        if (splitId > 3636) return false; // Maximum valid split ID is 3536 (35-36)
        
        uint256 num1 = splitId / 100;
        uint256 num2 = splitId % 100;
        
        // Both numbers must be 0-36
        if (num1 > 36 || num2 > 36) return false;
        
        // Check if they are adjacent (horizontal or vertical)
        bool horizontalAdjacent = (num1 + 1 == num2) && (num1 % 3 != 0); // Same row, next column
        bool verticalAdjacent = (num1 + 3 == num2) && (num1 <= 33); // Next row, same column
        
        return horizontalAdjacent || verticalAdjacent;
    }
    
    /**
     * @dev Validate if a corner ID represents a valid 2x2 square
     */
    function isValidCorner(uint256 cornerId) private pure returns (bool) {
        if (cornerId == 0) return true; // Special case for 0-1-2-3 corner
        
        // For regular corners, the ID should be the top-left number of a 2x2 square
        if (cornerId < 1 || cornerId > 33) return false;
        
        // Check if it's a valid top-left corner (not in the rightmost column)
        // and ensure the 2x2 square doesn't go beyond the table
        return cornerId % 3 != 0 && cornerId <= 33;
    }
    
    /**
     * @dev Check if number is red
     */
    function _isRedNumber(uint256 num) private pure returns (bool) {
        // Red numbers in European roulette: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
        return (num == 1 || num == 3 || num == 5 || num == 7 || num == 9 ||
                num == 12 || num == 14 || num == 16 || num == 18 || num == 19 ||
                num == 21 || num == 23 || num == 25 || num == 27 || num == 30 ||
                num == 32 || num == 34 || num == 36);
    }
    
    /**
     * @dev Check if number is part of the 0-1-2 trio
     */
    function _isTrio012Number(uint256 num) private pure returns (bool) {
        return num == 0 || num == 1 || num == 2;
    }

    /**
     * @dev Check if number is part of the 0-2-3 trio
     */
    function _isTrio023Number(uint256 num) private pure returns (bool) {
        return num == 0 || num == 2 || num == 3;
    }
    
    /**
     * @dev Collect winning payouts for a specific batch range (ULTRA OPTIMIZED - NO WASTED ITERATIONS)
     */
    function _collectWinningPayoutsBatch(
        RouletteStorage storage $,
        uint256 roundId,
        uint256 winningNumber,
        WinningBetTypes memory winningTypes,
        uint256 startIndex,
        uint256 batchSize
    ) private view returns (PayoutInfo[] memory, uint256) {
        PayoutInfo[] memory tempPayouts = new PayoutInfo[](batchSize);
        CollectWinningsValues memory v = CollectWinningsValues({
            payoutCount: 0,
            totalPayouts: 0,
            currentIndex: 0,
            endIndex: startIndex + batchSize
        });
        // Process each bet type in order, skipping entire arrays when possible
        
        // 1. STRAIGHT BETS
        (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundStraightBets[roundId][winningNumber], 36, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        
        // 2. SPLIT BETS
        uint256 j;
        for (; j < winningTypes.winningSplits.length && v.payoutCount < batchSize;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundSplitBets[roundId][winningTypes.winningSplits[j]], 18, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 3. STREET BETS
        if (winningTypes.winningStreets > 0 && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundStreetBets[roundId][winningTypes.winningStreets], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 4. CORNER BETS  
        for (j = 0; j < winningTypes.winningCorners.length && v.payoutCount < batchSize;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundCornerBets[roundId][winningTypes.winningCorners[j]], 9, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 5. LINE BETS
        for (j = 0; j < winningTypes.winningLines.length && v.payoutCount < batchSize;) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundLineBets[roundId][winningTypes.winningLines[j]], 6, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
            unchecked { ++j; }
        }
        
        // 6. COLUMN BETS
        if (winningTypes.winningColumn > 0 && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundColumnBets[roundId][winningTypes.winningColumn], 3, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 7. DOZEN BETS
        if (winningTypes.winningDozen > 0 && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundDozenBets[roundId][winningTypes.winningDozen], 3, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // 8. SIMPLE OUTSIDE BETS (1:1 payouts) - use simple function for basic arrays
        if (winningTypes.red && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundRedBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (winningTypes.black && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundBlackBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (winningTypes.odd && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundOddBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (winningTypes.even && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundEvenBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (winningTypes.low && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundLowBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        if (winningTypes.high && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundHighBets[roundId], 2, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }

        if (winningTypes.trio012 && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundTrio012Bets[roundId], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }

        if (winningTypes.trio023 && v.payoutCount < batchSize) {
            (v.currentIndex, v.payoutCount, v.totalPayouts) = _skipOrProcessSimpleBets($.roundTrio023Bets[roundId], 12, tempPayouts, v.payoutCount, v.currentIndex, startIndex, v.endIndex, v.totalPayouts);
        }
        
        // Use assembly to resize array to actual size
        assembly {
            mstore(tempPayouts, mload(v))
        }

        return (tempPayouts, v.totalPayouts);
    }
    
    /**
     * @dev Helper for direct storage access with minimal memory usage (ULTRA EFFICIENT)
     */ 
    function _skipOrProcessSimpleBets(
        Bet[] storage bets,
        uint256 multiplier,
        PayoutInfo[] memory tempPayouts,
        uint256 payoutCount,
        uint256 currentIndex,
        uint256 startIndex,
        uint256 endIndex,
        uint256 totalPayouts
    ) private view returns (uint256 newCurrentIndex, uint256 newPayoutCount, uint256) {
        SkipOrProcessSimpleBetsValues memory v = SkipOrProcessSimpleBetsValues({
            betsLength: bets.length,
            rangeStart: startIndex > currentIndex ? startIndex - currentIndex : 0,
            rangeEnd: endIndex - currentIndex
        });
        
        
        // Skip entire array if it's completely before our batch
        if (currentIndex + v.betsLength <= startIndex) {
            return (currentIndex + v.betsLength, payoutCount, 0);
        }
        
        // Calculate exact range - no memory waste
        if (v.rangeEnd > v.betsLength) v.rangeEnd = v.betsLength;
        
        // Access only needed storage slots
        Bet memory currentBet;
        uint256 payout;
        for (uint256 i = v.rangeStart; i < v.rangeEnd && payoutCount < tempPayouts.length;) {
            currentBet = bets[i];
            unchecked {
                payout = currentBet.amount * multiplier;
                totalPayouts += payout;
                tempPayouts[payoutCount++] = PayoutInfo({
                player: currentBet.player,
                betAmount: currentBet.amount,
                payout: payout
            });
            ++i;
            }
        }
        
        return (currentIndex + v.betsLength, payoutCount, totalPayouts);
    }
    
    /**
     * @dev Calculate total batches needed for winning bets
     */
    function _calculateTotalBatches(uint256 totalWinningBets) private pure returns (uint256) {
        if (totalWinningBets == 0) return 0;
        if (totalWinningBets <= BATCH_SIZE) return 1;
        // Proper ceil division: if remainder exists, add 1 batch
        return (totalWinningBets / BATCH_SIZE) + (totalWinningBets % BATCH_SIZE > 0 ? 1 : 0);
    }
    
    /**
     * @dev Count total winning bets for a round
     * Uses array.length which is O(1) and efficient enough for checkUpkeep's 6.5M gas limit
     */
    function _countTotalWinningBets(
        RouletteStorage storage $,
        uint256 roundId,
        uint256 winningNumber,
        WinningBetTypes memory winningTypes
    ) private view returns (uint256 totalCount) {
        // 1. STRAIGHT BETS - array.length is O(1)
        totalCount += $.roundStraightBets[roundId][winningNumber].length;
        uint256 j;
        // 2. SPLIT BETS - sum winning split array lengths
        for (; j < winningTypes.winningSplits.length;) {
            totalCount += $.roundSplitBets[roundId][winningTypes.winningSplits[j]].length;
            unchecked { ++j; }
        }
        
        // 3. STREET BETS - sum winning street array lengths
        if (winningTypes.winningStreets > 0) {
            totalCount += $.roundStreetBets[roundId][winningTypes.winningStreets].length;
        }
        
        // 4. CORNER BETS - sum winning corner array lengths
        for (j = 0; j < winningTypes.winningCorners.length;) {
            totalCount += $.roundCornerBets[roundId][winningTypes.winningCorners[j]].length;
            unchecked { ++j; }
        }
        
        // 5. LINE BETS - sum winning line array lengths
        for (j = 0; j < winningTypes.winningLines.length;) {
            totalCount += $.roundLineBets[roundId][winningTypes.winningLines[j]].length;
            unchecked { ++j; }
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

    // ========== VIEW FUNCTIONS ==========
    
    /**
     * @dev Get upkeep configuration and bet limits
     */
    function getUpkeepConfig() external view returns (
        uint256 maxSupportedBets,
        uint256 registeredUpkeepCount,
        uint256 batchSize,
        uint32 upkeepGasLimit
    ) {
        RouletteStorage storage $ = _getRouletteStorage();
        return (
            $.maxSupportedBets,
            $.registeredUpkeepCount,
            BATCH_SIZE,
            UPKEEP_GAS_LIMIT
        );
    }
    
    /**
     * @dev Check if more bets can be placed in current round
     */
    function canPlaceBets(uint256 additionalBets) external view returns (bool) {
        RouletteStorage storage $ = _getRouletteStorage();
        uint256 currentBets = $.totalBetsInRound[$.currentRound];
        return (currentBets + additionalBets) <= $.maxSupportedBets;
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
     * @dev Get round VRF result
     */
    function getRoundResult(uint256 roundId) external view returns (uint256 winningNumber, bool isSet) {
        RouletteStorage storage $ = _getRouletteStorage();
        RandomResult memory result = $.randomResults[roundId];
        return (result.randomWord, result.set);
    }
    
    /**
     * @dev Get round bets count
     */
    function getRoundBetsCount(uint256 roundId) external view returns (uint256) {
        RouletteStorage storage $ = _getRouletteStorage();
        return $.totalBetsInRound[roundId];
    }
    
    /**
     * @dev Check if round is resolved (based on lastRoundPaid)
     */
    function isRoundResolved(uint256 roundId) external view returns (bool) {
        RouletteStorage storage $ = _getRouletteStorage();
        return roundId <= $.lastRoundPaid;
    }
    
    /**
     * @dev Get batch processing status for a round
     */
    function getRoundBatchStatus(uint256 roundId) external view returns (
        uint256 batchesProcessed,
        uint256 totalBatches,
        bool isFullyProcessed,
        uint256 totalWinningBets // Added to return the actual count of winning bets
    ) {
        RouletteStorage storage $ = _getRouletteStorage();
        batchesProcessed = _calculateTotalBatches($.winningBetsProcessed[roundId]);
        // Calculate total batches by computing winning bets for resolved rounds
        if ($.randomResults[roundId].set) {
            uint256 winningNumber = $.randomResults[roundId].randomWord;
            WinningBetTypes memory winningTypes = _getWinningBetTypes(winningNumber);
            totalWinningBets = _countTotalWinningBets($, roundId, winningNumber, winningTypes);
            totalBatches = _calculateTotalBatches(totalWinningBets);
        } else {
            totalBatches = 0; // Round not resolved yet
            totalWinningBets = 0; // No winning bets if not resolved
        }
        
        isFullyProcessed = $.winningBetsProcessed[roundId] == $.totalWinningBets[roundId];
    }
    
    /**
     * @dev Check if a specific batch has been processed
     */
    function isBatchProcessed(uint256 roundId, uint256 batchIndex) external view returns (bool) {
        RouletteStorage storage $ = _getRouletteStorage();
        uint256 batchBitmap = $.roundBatchBitmap[roundId];
        return (batchBitmap & (1 << batchIndex)) != 0;
    }
    
    function getSecondsFromNextUpkeepWindow() external view returns (uint256) {
        RouletteStorage storage $ = _getRouletteStorage();
        uint256 srt = $.lastRoundStartTime;
        uint256 gamePeriod = GAME_PERIOD;
        uint256 elapsed = block.timestamp - srt;
        uint256 remainder = elapsed % gamePeriod;
        return (elapsed >= gamePeriod && remainder <= TIME_MARGIN) ? 0 : gamePeriod - remainder; // 0 if in upkeep window, otherwise time until next window
    }
    
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}