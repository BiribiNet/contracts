// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AutomationCompatibleInterface } from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import { Strings } from "./external/Strings.sol";
import { IAutomationRegistrar2_1 } from "./interfaces/IAutomationRegistrar2_1.sol";
import { IAutomationRegistry2_1 } from "./interfaces/IAutomationRegistry2_1.sol";
import { IBRBUpkeepManager } from "./interfaces/IBRBUpkeepManager.sol";
import { IStakedBRBCleaning } from "./interfaces/IStakedBRBCleaning.sol";

/**
 * @title BRBUpkeepManager
 * @dev Registers Chainlink Automation upkeeps for RouletteClean and records forwarders only from successful registrar calls.
 *      DEFAULT_ADMIN cannot add/remove forwarders directly — only successful `registerUpkeep` adds a forwarder.
 *      Use REGISTRANT_ROLE for ops that may register upkeeps; admin only manages roles.
 */
contract BRBUpkeepManager is AccessControl, IBRBUpkeepManager, AutomationCompatibleInterface {
    bytes32 public constant REGISTRANT_ROLE = keccak256("REGISTRANT_ROLE");

    uint32 private constant BASE_GAS_OVERHEAD = 100000;
    uint32 private constant GAS_PER_WINNING_BET = 50000;
    uint32 public constant BATCH_SIZE = 35;
    uint32 public constant UPKEEP_GAS_LIMIT = BASE_GAS_OVERHEAD + (BATCH_SIZE * GAS_PER_WINNING_BET);
    uint32 public constant BOUNDARY_SYNC_GAS_LIMIT = 200000;

    uint256 private constant MAX_PAYOUT_UPKEEPS = 256;

    address public immutable ROULETTE;
    address public immutable STAKED_BRB;
    address public immutable LINK_TOKEN;
    address public immutable KEEPER_REGISTRAR;
    address public immutable KEEPER_REGISTRY;

    /// @dev Gas limit for StakedBRB cleaning upkeep (must match vault cleaning work budget).
    uint32 public constant STAKED_BRB_CLEANING_GAS_LIMIT = 2_000_000;

    /// @dev forwarder => Chainlink upkeep id for **RouletteClean** upkeeps only
    mapping(address => uint256) private _rouletteForwarderToUpkeepId;
    /// @dev forwarder => Chainlink upkeep id for **StakedBRB cleaning** (manager is upkeep contract)
    mapping(address => uint256) private _stakedBrbCleaningForwarderToUpkeepId;

    uint256 private _registeredPayoutUpkeepCount;

    error ZeroAddress();
    error ZeroAmount();
    error UpkeepRegistrationFailed();
    error MaxPayoutUpkeepLimitReached();
    error UnauthorizedStakedBrbCleaningForwarder();

    event UpkeepRegistered(
        uint256 indexed upkeepId,
        address indexed forwarder,
        uint32 gasLimit,
        uint96 linkAmount,
        uint256 checkDataLength,
        string upkeepType
    );
    /// @dev Same signature as former StakedBRB.CleaningUpkeepRegistered for indexing compatibility.
    event CleaningUpkeepRegistered(
        uint256 indexed upkeepId,
        address indexed forwarder,
        uint32 gasLimit,
        uint96 linkAmount,
        string upkeepType
    );
    event MaxSupportedBetsUpdated(uint256 maxSupportedBets, uint256 totalPayoutUpkeeps);

    constructor(
        address roulette,
        address stakedBRB,
        address linkToken,
        address keeperRegistrar,
        address keeperRegistry,
        address defaultAdmin,
        address initialRegistrant
    ) {
        if (
            roulette == address(0) ||
            stakedBRB == address(0) ||
            linkToken == address(0) ||
            keeperRegistrar == address(0) ||
            keeperRegistry == address(0) ||
            defaultAdmin == address(0)
        ) revert ZeroAddress();

        ROULETTE = roulette;
        STAKED_BRB = stakedBRB;
        LINK_TOKEN = linkToken;
        KEEPER_REGISTRAR = keeperRegistrar;
        KEEPER_REGISTRY = keeperRegistry;

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        if (initialRegistrant != address(0)) {
            _grantRole(REGISTRANT_ROLE, initialRegistrant);
        }

        IERC20(linkToken).approve(keeperRegistrar, type(uint256).max);
    }

    /// @inheritdoc IBRBUpkeepManager
    function isAuthorizedForwarder(address forwarder) external view returns (bool) {
        return _rouletteForwarderToUpkeepId[forwarder] != 0;
    }

    /// @inheritdoc IBRBUpkeepManager
    function isStakedBrbCleaningForwarder(address forwarder) external view returns (bool) {
        return _stakedBrbCleaningForwarderToUpkeepId[forwarder] != 0;
    }

    /// @inheritdoc AutomationCompatibleInterface
    function checkUpkeep(bytes calldata checkData) external view override returns (bool upkeepNeeded, bytes memory performData) {
        return IStakedBRBCleaning(STAKED_BRB).checkCleaningUpkeep(checkData);
    }

    /// @inheritdoc AutomationCompatibleInterface
    function performUpkeep(bytes calldata performData) external override {
        if (_stakedBrbCleaningForwarderToUpkeepId[msg.sender] == 0) revert UnauthorizedStakedBrbCleaningForwarder();
        IStakedBRBCleaning(STAKED_BRB).executeCleaningUpkeep(performData);
    }

    /// @dev Register StakedBRB cleaning upkeep; `upkeepContract` is this manager. Requires REGISTRANT_ROLE.
    function registerStakedBrbCleaningUpkeep(uint96 linkAmount) external onlyRole(REGISTRANT_ROLE) returns (uint256 upkeepId) {
        if (linkAmount == 0) revert ZeroAmount();
        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), linkAmount);

        upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: "StakedBRB-Cleaning",
                encryptedEmail: new bytes(0),
                upkeepContract: address(this),
                gasLimit: STAKED_BRB_CLEANING_GAS_LIMIT,
                adminAddress: msg.sender,
                triggerType: 0,
                checkData: new bytes(0),
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert UpkeepRegistrationFailed();

        address forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
        _stakedBrbCleaningForwarderToUpkeepId[forwarder] = upkeepId;

        emit CleaningUpkeepRegistered(upkeepId, forwarder, STAKED_BRB_CLEANING_GAS_LIMIT, linkAmount, "Cleaning");
        emit UpkeepRegistered(upkeepId, forwarder, STAKED_BRB_CLEANING_GAS_LIMIT, linkAmount, 0, "STAKED_BR_CLEANING");
    }

    /// @inheritdoc IBRBUpkeepManager
    function maxSupportedBets() external view returns (uint256) {
        return _registeredPayoutUpkeepCount * uint256(BATCH_SIZE);
    }

    /// @inheritdoc IBRBUpkeepManager
    function registeredPayoutUpkeepCount() external view returns (uint256) {
        return _registeredPayoutUpkeepCount;
    }

    /// @inheritdoc IBRBUpkeepManager
    function batchSize() external pure returns (uint256) {
        return BATCH_SIZE;
    }

    /// @inheritdoc IBRBUpkeepManager
    function upkeepGasLimit() external pure returns (uint32) {
        return UPKEEP_GAS_LIMIT;
    }

    /// @inheritdoc IBRBUpkeepManager
    function boundarySyncGasLimit() external pure returns (uint32) {
        return BOUNDARY_SYNC_GAS_LIMIT;
    }

    function registerVRFUpkeep(uint96 linkAmount) external onlyRole(REGISTRANT_ROLE) returns (uint256 upkeepId) {
        if (linkAmount == 0) revert ZeroAmount();
        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), linkAmount);

        string memory upkeepName = string.concat("RouletteClean-VRF-", Strings.toHexString(ROULETTE));

        upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: ROULETTE,
                gasLimit: UPKEEP_GAS_LIMIT,
                adminAddress: msg.sender,
                triggerType: 0,
                checkData: hex"01",
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert UpkeepRegistrationFailed();

        address forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
        _rouletteForwarderToUpkeepId[forwarder] = upkeepId;

        emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmount, 1, "VRF");
    }

    /// @dev Pre-VRF lock: empty checkData — must run before the VRF upkeep (single byte, e.g. 0x01) on each round.
    function registerPreVrfLockUpkeep(uint96 linkAmount) external onlyRole(REGISTRANT_ROLE) returns (uint256 upkeepId) {
        if (linkAmount == 0) revert ZeroAmount();
        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), linkAmount);

        string memory upkeepName = string.concat("RouletteClean-PreVrfLock-", Strings.toHexString(ROULETTE));

        upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: ROULETTE,
                gasLimit: BOUNDARY_SYNC_GAS_LIMIT,
                adminAddress: msg.sender,
                triggerType: 0,
                checkData: new bytes(0),
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert UpkeepRegistrationFailed();

        address forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
        _rouletteForwarderToUpkeepId[forwarder] = upkeepId;

        emit UpkeepRegistered(upkeepId, forwarder, BOUNDARY_SYNC_GAS_LIMIT, linkAmount, 0, "PRE_VRF_LOCK");
    }

    function registerComputeTotalWinningBetsUpkeep(uint96 linkAmount) external onlyRole(REGISTRANT_ROLE) returns (uint256 upkeepId) {
        if (linkAmount == 0) revert ZeroAmount();
        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), linkAmount);

        string memory upkeepName = string.concat("RouletteClean-ComputeTotalWinningBets-", Strings.toHexString(ROULETTE));

        upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: upkeepName,
                encryptedEmail: new bytes(0),
                upkeepContract: ROULETTE,
                gasLimit: UPKEEP_GAS_LIMIT,
                adminAddress: msg.sender,
                triggerType: 0,
                checkData: new bytes(2),
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert UpkeepRegistrationFailed();

        address forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
        _rouletteForwarderToUpkeepId[forwarder] = upkeepId;

        emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmount, 2, "COMPUTE_TOTAL_WINNING_BETS");
    }

    function registerPayoutUpkeeps(uint256 upkeepCount, uint96 linkAmountPerUpkeep) external onlyRole(REGISTRANT_ROLE) {
        if (upkeepCount == 0) revert ZeroAmount();

        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), upkeepCount * uint256(linkAmountPerUpkeep));

        uint256 oldCount = _registeredPayoutUpkeepCount;
        uint256 newCount = oldCount + upkeepCount;
        if (newCount > MAX_PAYOUT_UPKEEPS) revert MaxPayoutUpkeepLimitReached();

        bytes memory checkData;
        uint256 checkDataLength;
        string memory upkeepName;
        uint256 upkeepId;
        address forwarder;

        for (uint256 i = oldCount; i < newCount; ) {
            checkData = new bytes(i + 3);
            checkDataLength = checkData.length;

            upkeepName = string.concat(
                "RouletteClean-Payout-",
                Strings.toString(checkDataLength),
                "-",
                Strings.toHexString(ROULETTE)
            );

            upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
                IAutomationRegistrar2_1.RegistrationParams({
                    name: upkeepName,
                    encryptedEmail: new bytes(0),
                    upkeepContract: ROULETTE,
                    gasLimit: UPKEEP_GAS_LIMIT,
                    adminAddress: msg.sender,
                    triggerType: 0,
                    checkData: checkData,
                    triggerConfig: new bytes(0),
                    offchainConfig: new bytes(0),
                    amount: linkAmountPerUpkeep
                })
            );

            if (upkeepId == 0) revert UpkeepRegistrationFailed();

            forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
            _rouletteForwarderToUpkeepId[forwarder] = upkeepId;

            emit UpkeepRegistered(upkeepId, forwarder, UPKEEP_GAS_LIMIT, linkAmountPerUpkeep, checkDataLength, "PAYOUT");

            unchecked {
                ++i;
            }
        }

        _registeredPayoutUpkeepCount = newCount;

        emit MaxSupportedBetsUpdated(newCount * uint256(BATCH_SIZE), newCount);
    }
}
