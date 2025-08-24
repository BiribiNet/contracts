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

// ========== CHAINLINK AUTOMATION INTERFACES ==========
interface IAutomationRegistrar2_1 {
    struct RegistrationParams {
        string name;
        bytes encryptedEmail;
        address upkeepContract;
        uint32 gasLimit;
        address adminAddress;
        uint8 triggerType;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
        uint96 amount; // LINK amount to fund
    }
    
    function registerUpkeep(RegistrationParams calldata requestParams) external returns (uint256);
}

interface IAutomationRegistry2_1 {
    function getForwarder(uint256 upkeepId) external view returns (address);
}

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
    
    // ========== EIP-7201 STORAGE ==========
    struct RouletteStorage {
        uint256 currentRound;
        uint256 lastRoundStartTime;
        uint256 lastRoundPaid; // Last round where all users were paid
        
        // EFFICIENT BET COUNTER (instead of gas-intensive loops)
        mapping(uint256 => uint256) totalBetsInRound; // roundId => total bet count
        
        // GRANULAR BATCH TRACKING (prevent duplicate upkeeps)
        mapping(uint256 => uint256) roundBatchesProcessed; // roundId => highest batch index processed
        
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
        
        // EUROPEAN SECTION BETS
        mapping(uint256 => Bet[]) roundVoisinsBets;   // roundId => voisins du zéro bets
        mapping(uint256 => Bet[]) roundTiersBets;     // roundId => tiers du cylindre bets
        mapping(uint256 => Bet[]) roundOrphelinsBets; // roundId => orphelins bets
        
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
        uint256 triggerType; // 0 = VRF trigger, 1 = payout users
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
        uint256 roundId;
        uint256 winningNumber;
        PayoutInfo[] payouts; // Pre-computed payouts for this batch
        uint256 batchIndex; // Pre-computed batch index
        uint256 totalWinningBets; // Pre-computed total winning bets for this round
        bool isLastBatch; // Pre-computed flag if this is the last batch
    }
    
    struct WinningBetTypes {
        // INSIDE BETS
        uint256[] winningSplits;    // Split IDs that win
        uint256[] winningStreets;   // Street numbers that win  
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
        
        // EUROPEAN SECTION BETS
        bool voisins;    // Voisins du zéro
        bool tiers;      // Tiers du cylindre  
        bool orphelins;  // Orphelins
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
    uint256 constant BET_VOISINS = 14;    // Voisins du zéro (17 numbers)
    uint256 constant BET_TIERS = 15;      // Tiers du cylindre (12 numbers)
    uint256 constant BET_ORPHELINS = 16;  // Orphelins (8 numbers)
    
    // ========== MULTIPLE BETS STRUCTURE ==========
    struct MultipleBets {
        uint256[] amounts;   // Array of bet amounts
        uint256[] betTypes;  // Array of bet types
        uint256[] numbers;   // Array of numbers (0 for non-straight bets)
    }
    
    // ========== EVENTS ==========
    event BetPlaced(address player, uint256 amount, uint256 betType, uint256 number);
    event RoundStarted(uint256 roundId, uint256 timestamp, uint256 requestId);
    event RoundResolved(uint256 roundId, uint256 winningNumber);
    event VRFResult(uint256 roundId, uint256 winningNumber);
    event BatchProcessed(uint256 indexed roundId, uint256 batchIndex, uint256 payoutsCount);
    event ChainlinkSetupCompleted(uint256 indexed subscriptionId, address keeperRegistrar, address keeperRegistry);
    event UpkeepRegistered(uint256 indexed upkeepId, address indexed forwarder, uint32 gasLimit, uint96 linkAmount, uint256 batchIndex, string upkeepType);
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
        if (!IERC20($.linkToken).transferFrom(msg.sender, address(this), linkAmount)) {
            revert TransferFailed();
        }
        
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
        if (!IERC20($.linkToken).transferFrom(msg.sender, address(this), totalLinkNeeded)) {
            revert TransferFailed();
        }
        
        uint256[] memory upkeepIds = new uint256[](upkeepCount);
        
        for (uint256 i; i < upkeepCount;) {
            // checkData.length determines batch range: length 1 = batch 0, length 2 = batch 1, etc.
            bytes memory checkData = new bytes(i + 1);
            
            string memory upkeepName = string.concat(
                "RouletteClean-Payout-",
                Strings.toString(i),
                "-",
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
                    checkData: checkData, // Length determines batch index
                    triggerConfig: new bytes(0),
                    offchainConfig: new bytes(0),
                    amount: linkAmountPerUpkeep
                })
            );
            
            if (upkeepId == 0) revert UpkeepRegistrationFailed();
            
            // Get forwarder address and register it
            address forwarder = IAutomationRegistry2_1($.keeperRegistry).getForwarder(upkeepId);
            $.forwarders[forwarder] = upkeepId;
            
            upkeepIds[i] = upkeepId;
            
            emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmountPerUpkeep, i, "Payout");
            
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
        external 
    {
        // Only allow calls from the immutable StakedBRB contract
        if (msg.sender != STAKED_BRB_CONTRACT) revert UnauthorizedCaller();
        
        // Basic validation
        if (sender == address(0)) revert ZeroAddress();
        if (totalValue == 0) revert ZeroAmount();
        if (data.length == 0) revert MalformedData();
        
        RouletteStorage storage $ = _getRouletteStorage();
        
        // ALWAYS decode as MultipleBets - direct decoding for gas efficiency
        // abi.decode will revert automatically on malformed data
        _processMultipleBets(sender, totalValue, abi.decode(data, (MultipleBets)), $);
    }
    
    /**
     * @dev Process multiple bets
     */
    function _processMultipleBets(address sender, uint256 totalValue, MultipleBets memory bets, RouletteStorage storage $) internal {
        uint256 betsLength = bets.amounts.length; // Cache array length
        
        // Validate arrays have same length
        if (betsLength != bets.betTypes.length || betsLength != bets.numbers.length) {
            revert ArrayLengthMismatch();
        }
        
        if (betsLength == 0) revert EmptyBetsArray();
        
        // Cache storage reads
        uint256 currentRound = $.currentRound;
        
        // Check if total bets in round would exceed maximum supported
        if ($.totalBetsInRound[currentRound] + betsLength > $.maxSupportedBets) {
            revert BetLimitExceeded();
        }
        
        // SINGLE LOOP: Validate total AND process bets in one pass
        uint256 calculatedTotal;
        uint256 amount;
        for (uint256 i; i < betsLength;) {
            amount = bets.amounts[i];
            calculatedTotal += amount;
            
            // Validate and store bet
            _validateAndStoreBet(
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
        
        // EFFICIENT: Increment bet counter ONCE with total count
        unchecked {
            $.totalBetsInRound[currentRound] += betsLength;
        }
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
    ) internal {
        // Validate bet amount
        if (amount == 0 || amount < 1000) revert ZeroAmount();
        if (amount > 1000 ether) revert InvalidBet(); // Maximum 1000 BRB per bet
        
        // Validate bet type
        if (betType == 0 || betType > BET_ORPHELINS) revert InvalidBetType();
        
        // Validate number parameter based on bet type
        if (betType == BET_STRAIGHT) {
            // Straight bet: number must be 0-36
            if (number > 36) revert InvalidNumber();
        } else if (betType == BET_SPLIT) {
            // Split bet: validate split ID (we'll add validation later)
            if (number > 60) revert InvalidNumber(); // Max ~60 possible splits
        } else if (betType == BET_STREET) {
            // Street bet: number should be first number of street (1, 4, 7, etc.)
            if (number == 0 || number > 34 || (number - 1) % 3 != 0) revert InvalidNumber();
        } else if (betType == BET_CORNER) {
            // Corner bet: validate corner ID  
            if (number > 22) revert InvalidNumber(); // Max ~22 possible corners
        } else if (betType == BET_LINE) {
            // Line bet: first number of first street (1, 4, 7, etc.)
            if (number == 0 || number > 31 || (number - 1) % 3 != 0) revert InvalidNumber();
        } else if (betType == BET_COLUMN) {
            // Column bet: 1, 2, or 3
            if (number == 0 || number > 3) revert InvalidNumber();
        } else if (betType == BET_DOZEN) {
            // Dozen bet: 1, 2, or 3  
            if (number == 0 || number > 3) revert InvalidNumber();
        } else {
            // All other bet types: number parameter must be 0
            if (number != 0) revert InvalidNumber();
        }
        
        // Store the bet in appropriate mapping for efficient lookup
        Bet memory newBet = Bet({
            player: sender,
            amount: amount,
            betType: betType,
            number: number
        });
        
        // DEALER-STYLE STORAGE: Each bet type goes to its specific section (using cached currentRound)
        if (betType == BET_STRAIGHT) {
            $.roundStraightBets[currentRound][number].push(newBet);
        } else if (betType == BET_SPLIT) {
            $.roundSplitBets[currentRound][number].push(newBet);
        } else if (betType == BET_STREET) {
            $.roundStreetBets[currentRound][number].push(newBet);
        } else if (betType == BET_CORNER) {
            $.roundCornerBets[currentRound][number].push(newBet);
        } else if (betType == BET_LINE) {
            $.roundLineBets[currentRound][number].push(newBet);
        } else if (betType == BET_COLUMN) {
            $.roundColumnBets[currentRound][number].push(newBet);
        } else if (betType == BET_DOZEN) {
            $.roundDozenBets[currentRound][number].push(newBet);
        } else if (betType == BET_RED) {
            $.roundRedBets[currentRound].push(newBet);
        } else if (betType == BET_BLACK) {
            $.roundBlackBets[currentRound].push(newBet);
        } else if (betType == BET_ODD) {
            $.roundOddBets[currentRound].push(newBet);
        } else if (betType == BET_EVEN) {
            $.roundEvenBets[currentRound].push(newBet);
        } else if (betType == BET_LOW) {
            $.roundLowBets[currentRound].push(newBet);
        } else if (betType == BET_HIGH) {
            $.roundHighBets[currentRound].push(newBet);
        } else if (betType == BET_VOISINS) {
            $.roundVoisinsBets[currentRound].push(newBet);
        } else if (betType == BET_TIERS) {
            $.roundTiersBets[currentRound].push(newBet);
        } else if (betType == BET_ORPHELINS) {
            $.roundOrphelinsBets[currentRound].push(newBet);
        }
        
        emit BetPlaced(sender, amount, betType, number);
    }
    
    /**
     * @dev Chainlink Automation: Check if upkeep needed
     * @param checkData Empty for VRF trigger, length determines user batch range for payouts
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
                    triggerType: 0,
                    payload: abi.encode(TriggerVRF({
                        newLastRoundStartTimestamp: srt + (elapsed / GAME_PERIOD) * GAME_PERIOD,
                        newRoundId: currentRound + 1
                    }))
                }));
            }
        } else {
            // PAYOUT USERS: Check if we need to pay users from completed rounds
            uint256 roundToBePaid = $.lastRoundPaid + 1;
            
            // Only process if round exists and has VRF result (check lastRoundPaid instead of roundResolved)
            if (roundToBePaid < $.currentRound && $.randomResults[roundToBePaid].set && roundToBePaid > $.lastRoundPaid) {
                // Calculate batch range based on checkData.length
                // checkData.length == 1: batch 0 (users 0-9)
                // checkData.length == 2: batch 1 (users 10-19)
                // checkData.length == n: batch n-1
                
                uint256 batchIndex = checkData.length - 1; // 0-indexed
                uint256 startIndex = batchIndex * BATCH_SIZE;
                
                // GRANULAR CHECK: Only process if this specific batch hasn't been processed yet
                uint256 highestBatchProcessed = $.roundBatchesProcessed[roundToBePaid];
                bool batchAlreadyProcessed = batchIndex < highestBatchProcessed;
                
                // We need to calculate winning bets first to know if this batch is valid
                if (!batchAlreadyProcessed) {
                    uint256 winningNumber = $.randomResults[roundToBePaid].randomWord;
                    WinningBetTypes memory winningTypes = _getWinningBetTypes(winningNumber);
                    
                    // Get winning payouts ONLY for this specific batch range
                    PayoutInfo[] memory payouts = _collectWinningPayoutsBatch(
                        $, 
                        roundToBePaid, 
                        winningNumber, 
                        winningTypes,
                        startIndex,
                        BATCH_SIZE
                    );
                    
                    // Calculate total winning bets directly (no storage needed)
                    uint256 totalWinningBets = _countTotalWinningBets($, roundToBePaid, winningNumber, winningTypes);
                    
                    // Pre-compute all batch information here to minimize _processBatch gas
                    uint256 totalBatchesNeeded = _calculateTotalBatches(totalWinningBets);
                    bool isLastBatch = (batchIndex + 1) >= totalBatchesNeeded;
                    
                    // Only proceed if this batch has winning users to pay
                    if (startIndex < totalWinningBets && payouts.length > 0) {
                        upkeepNeeded = true;
                        performData = abi.encode(PerformDataPayload({
                            roundId: roundToBePaid,
                            triggerType: 1,
                            payload: abi.encode(PayoutBatch({
                                roundId: roundToBePaid,
                                winningNumber: winningNumber,
                                payouts: payouts,
                                batchIndex: batchIndex,
                                totalWinningBets: totalWinningBets,
                                isLastBatch: isLastBatch
                            }))
                        }));
                    }
                }
            }
        }
    }
    
    /**
     * @dev Chainlink Automation: Perform upkeep based on trigger type
     */
    function performUpkeep(bytes calldata performData) external override onlyForwarders {
        PerformDataPayload memory payload = abi.decode(performData, (PerformDataPayload));
        
        if (payload.triggerType == 0) {
            // VRF TRIGGER: Start new round and request VRF
            TriggerVRF memory triggerData = abi.decode(payload.payload, (TriggerVRF));
            _triggerVRF(payload.roundId, triggerData);
        } else if (payload.triggerType == 1) {
            // PAYOUT USERS: Process batch of users for a round
            PayoutBatch memory batchData = abi.decode(payload.payload, (PayoutBatch));
            _processBatch(batchData);
        }
    }
    
    /**
     * @dev Trigger VRF for current round and prepare new round
     */
    function _triggerVRF(uint256 roundId, TriggerVRF memory triggerData) internal {
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
    }
    
    /**
     * @dev Process a batch of users for payout - ULTRA MINIMAL: ONLY WRITES, CALLS, EMITS
     * @dev All computations moved to checkUpkeep for maximum gas efficiency
     */
    function _processBatch(PayoutBatch memory batchData) private {
        RouletteStorage storage $ = _getRouletteStorage();
        
        // WRITE: Update batch tracking using pre-computed values
        $.roundBatchesProcessed[batchData.roundId] = batchData.batchIndex + 1;
        
        emit BatchProcessed(batchData.roundId, batchData.batchIndex + 1, batchData.payouts.length);
        
        if (batchData.isLastBatch) {
            $.lastRoundPaid = batchData.roundId;
            emit RoundResolved(batchData.roundId, batchData.winningNumber);
            
        }

        // Single call to StakedBRB with entire batch
        (bool success, bytes memory returnData) = STAKED_BRB_CONTRACT.call(
            abi.encodeWithSelector(
                IStakedBRB.processRouletteResult.selector,
                batchData.payouts,
                batchData.isLastBatch
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
    function _getWinningBetTypes(uint256 winningNumber) internal pure returns (WinningBetTypes memory) {
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
        winning.voisins = _isVoisinsNumber(winningNumber);
        winning.tiers = _isTiersNumber(winningNumber);
        winning.orphelins = _isOrphelinsNumber(winningNumber);
        
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
    function _getWinningSplits(uint256 num) internal pure returns (uint256[] memory) {
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
    function _getWinningStreets(uint256 num) internal pure returns (uint256[] memory) {
        if (num == 0) return new uint256[](0);
        
        uint256[] memory streets = new uint256[](1);
        streets[0] = ((num - 1) / 3) * 3 + 1; // First number of the street
        return streets;
    }
    
    /**
     * @dev Get all corners that include this number
     */
    function _getWinningCorners(uint256 num) internal pure returns (uint256[] memory) {
        uint256[] memory corners = new uint256[](4);
        uint256 count;
        
        if (num == 0) return new uint256[](0);
        
        // Four possible corners for most numbers
        // Corner = top-left number of the 2x2 square
        
        // Top-left corner (num is bottom-right)
        if (num > 4 && num % 3 != 1) {
            corners[count++] = num - 4; // Top-left of corner
        }
        
        // Top-right corner (num is bottom-left)  
        if (num > 3 && num % 3 != 0) {
            corners[count++] = num - 3; // Top-left of corner
        }
        
        // Bottom-left corner (num is top-right)
        if (num < 33 && num % 3 != 1) {
            corners[count++] = num - 1; // Top-left of corner  
        }
        
        // Bottom-right corner (num is top-left)
        if (num < 34 && num % 3 != 0) {
            corners[count++] = num; // Top-left of corner
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
    function _getWinningLines(uint256 num) internal pure returns (uint256[] memory) {
        if (num == 0) return new uint256[](0);
        
        uint256[] memory lines = new uint256[](1);
        uint256 streetStart = ((num - 1) / 3) * 3 + 1;
        
        if (streetStart <= 31) {
            lines[0] = streetStart; // Line starts at first number of first street
            return lines;
        }
        
        return new uint256[](0);
    }
    
    /**
     * @dev Check if number is in Voisins du Zéro section
     */
    function _isVoisinsNumber(uint256 num) internal pure returns (bool) {
        // Voisins du zéro: 22,18,29,7,28,12,35,3,26,0,32,15,19,4,21,2,25
        return (num == 22 || num == 18 || num == 29 || num == 7 || num == 28 ||
                num == 12 || num == 35 || num == 3 || num == 26 || num == 0 ||
                num == 32 || num == 15 || num == 19 || num == 4 || num == 21 ||
                num == 2 || num == 25);
    }
    
    /**
     * @dev Check if number is in Tiers du Cylindre section  
     */
    function _isTiersNumber(uint256 num) internal pure returns (bool) {
        // Tiers du cylindre: 27,13,36,11,30,8,23,10,5,24,16,33
        return (num == 27 || num == 13 || num == 36 || num == 11 || num == 30 ||
                num == 8 || num == 23 || num == 10 || num == 5 || num == 24 ||
                num == 16 || num == 33);
    }
    
    /**
     * @dev Check if number is in Orphelins section
     */
    function _isOrphelinsNumber(uint256 num) internal pure returns (bool) {
        // Orphelins: 1,20,14,31,9,17,34,6
        return (num == 1 || num == 20 || num == 14 || num == 31 || 
                num == 9 || num == 17 || num == 34 || num == 6);
    }
    
    /**
     * @dev Generate split ID for two numbers
     */
    function _getSplitId(uint256 num1, uint256 num2) internal pure returns (uint256) {
        return num1 < num2 ? num1 * 100 + num2 : num2 * 100 + num1;
    }
    
    /**
     * @dev Check if number is red
     */
    function _isRedNumber(uint256 num) internal pure returns (bool) {
        // Red numbers in European roulette: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
        return (num == 1 || num == 3 || num == 5 || num == 7 || num == 9 ||
                num == 12 || num == 14 || num == 16 || num == 18 || num == 19 ||
                num == 21 || num == 23 || num == 25 || num == 27 || num == 30 ||
                num == 32 || num == 34 || num == 36);
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
    ) internal view returns (PayoutInfo[] memory payouts) {
        PayoutInfo[] memory tempPayouts = new PayoutInfo[](batchSize);
        uint256 payoutCount;
        uint256 currentIndex;
        uint256 endIndex = startIndex + batchSize;
        
        // Process each bet type in order, skipping entire arrays when possible
        
        // 1. STRAIGHT BETS
        (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundStraightBets[roundId][winningNumber], 35, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        
        // 2. SPLIT BETS
        uint256 j;
        for (; j < winningTypes.winningSplits.length && payoutCount < batchSize;) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundSplitBets[roundId][winningTypes.winningSplits[j]], 17, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
            unchecked { ++j; }
        }
        
        // 3. STREET BETS
        for (j = 0; j < winningTypes.winningStreets.length && payoutCount < batchSize;) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundStreetBets[roundId][winningTypes.winningStreets[j]], 11, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
            unchecked { ++j; }
        }
        
        // 4. CORNER BETS  
        for (j = 0; j < winningTypes.winningCorners.length && payoutCount < batchSize;) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundCornerBets[roundId][winningTypes.winningCorners[j]], 8, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
            unchecked { ++j; }
        }
        
        // 5. LINE BETS
        for (j = 0; j < winningTypes.winningLines.length && payoutCount < batchSize;) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundLineBets[roundId][winningTypes.winningLines[j]], 5, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
            unchecked { ++j; }
        }
        
        // 6. COLUMN BETS
        if (winningTypes.winningColumn > 0 && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundColumnBets[roundId][winningTypes.winningColumn], 2, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        
        // 7. DOZEN BETS
        if (winningTypes.winningDozen > 0 && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundDozenBets[roundId][winningTypes.winningDozen], 2, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        
        // 8. SIMPLE OUTSIDE BETS (1:1 payouts) - use simple function for basic arrays
        if (winningTypes.red && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundRedBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.black && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundBlackBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.odd && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundOddBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.even && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundEvenBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.low && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundLowBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.high && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundHighBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        
        // 9. EUROPEAN SECTION BETS
        if (winningTypes.voisins && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundVoisinsBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.tiers && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundTiersBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        if (winningTypes.orphelins && payoutCount < batchSize) {
            (currentIndex, payoutCount) = _skipOrProcessSimpleBets($.roundOrphelinsBets[roundId], 1, tempPayouts, payoutCount, currentIndex, startIndex, endIndex);
        }
        
        // Use assembly to resize array to actual size
        assembly {
            mstore(tempPayouts, payoutCount)
        }
        
        return tempPayouts;
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
        uint256 endIndex
    ) internal view returns (uint256 newCurrentIndex, uint256 newPayoutCount) {
        uint256 betsLength = bets.length;
        
        // Skip entire array if it's completely before our batch
        if (currentIndex + betsLength <= startIndex) {
            return (currentIndex + betsLength, payoutCount);
        }
        
        // Calculate exact range - no memory waste
        uint256 rangeStart = startIndex > currentIndex ? startIndex - currentIndex : 0;
        uint256 rangeEnd = endIndex - currentIndex;
        if (rangeEnd > betsLength) rangeEnd = betsLength;
        
        // Access only needed storage slots
        Bet memory currentBet;
        for (uint256 i = rangeStart; i < rangeEnd && payoutCount < tempPayouts.length;) {
            currentBet = bets[i];
            tempPayouts[payoutCount++] = PayoutInfo({
                player: currentBet.player,
                betAmount: currentBet.amount,
                payout: currentBet.amount * multiplier
            });
            unchecked { ++i; }
        }
        
        return (currentIndex + betsLength, payoutCount);
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
        
        // 2. SPLIT BETS - sum winning split array lengths
        for (uint256 j; j < winningTypes.winningSplits.length;) {
            totalCount += $.roundSplitBets[roundId][winningTypes.winningSplits[j]].length;
            unchecked { ++j; }
        }
        
        // 3. STREET BETS - sum winning street array lengths
        for (uint256 j; j < winningTypes.winningStreets.length;) {
            totalCount += $.roundStreetBets[roundId][winningTypes.winningStreets[j]].length;
            unchecked { ++j; }
        }
        
        // 4. CORNER BETS - sum winning corner array lengths
        for (uint256 j; j < winningTypes.winningCorners.length;) {
            totalCount += $.roundCornerBets[roundId][winningTypes.winningCorners[j]].length;
            unchecked { ++j; }
        }
        
        // 5. LINE BETS - sum winning line array lengths
        for (uint256 j; j < winningTypes.winningLines.length;) {
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
        if (winningTypes.voisins) totalCount += $.roundVoisinsBets[roundId].length;
        if (winningTypes.tiers) totalCount += $.roundTiersBets[roundId].length;
        if (winningTypes.orphelins) totalCount += $.roundOrphelinsBets[roundId].length;
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
        bool isFullyProcessed
    ) {
        RouletteStorage storage $ = _getRouletteStorage();
        batchesProcessed = $.roundBatchesProcessed[roundId];
        
        // Calculate total batches by computing winning bets for resolved rounds
        if ($.randomResults[roundId].set) {
            uint256 winningNumber = $.randomResults[roundId].randomWord;
            WinningBetTypes memory winningTypes = _getWinningBetTypes(winningNumber);
            uint256 totalWinningBets = _countTotalWinningBets($, roundId, winningNumber, winningTypes);
            totalBatches = _calculateTotalBatches(totalWinningBets);
        } else {
            totalBatches = 0; // Round not resolved yet
        }
        
        isFullyProcessed = batchesProcessed >= totalBatches && totalBatches > 0;
    }
    
    /**
     * @dev Check if a specific batch has been processed
     */
    function isBatchProcessed(uint256 roundId, uint256 batchIndex) external view returns (bool) {
        RouletteStorage storage $ = _getRouletteStorage();
        return batchIndex < $.roundBatchesProcessed[roundId];
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