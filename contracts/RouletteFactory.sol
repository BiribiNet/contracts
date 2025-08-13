// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {IVRFSubscriptionV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFSubscriptionV2Plus.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {LinkTokenInterface} from "@chainlink/contracts/src/v0.8/shared/interfaces/LinkTokenInterface.sol";
import {IAutomationRegistrar2_1} from "../external/AutomationRegistrar2_1.sol";`
import {IAutomationForwaderSetter} from "../interfaces/IAutomationForwaderSetter.sol";

contract RouletteFactory is AccessControlUpgradeable, UUPSUpgradeable {

    bytes32 private constant RANDOM_SELECTOR = 0x6b9d73f4b9bc1e28dca810eb156dbc48c55fa66b93342bf3929633247d2aee5c; // Random(uint256,uint256)

    enum ContractType {
        POOT,
        TEAMFIGHT,
        BINGO
    }

    enum TriggerType {
        LOG_TYPE,
        CUSTOM_TYPE
    }

    struct Upkeep {
        uint256 logUpkeepId;
        uint256 customUpkeepId;
    }

    struct TalusFactoryStorage {
        uint256 _subId; // slot 0
        mapping(ContractType => UpgradeableBeacon) _beacons; // slot 1
        IVRFSubscriptionV2Plus _vrfCoordinator; // slot 2
        IAutomationRegistrar2_1 _keeperRegistry; // slot 3
        mapping(address => Upkeep) _upkeeps; // slot 4
        LinkTokenInterface _linkToken; // slot 5
    }

    // keccak256(abi.encode(uint256(keccak256("BRB.storage.RouletteFactory")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ROULETTE_FACTORY_STORAGE = 0x81d676ef09f27bf2eb93bebe123613f9afefcdbc40c3ae57c76f1a256096ce00;
    uint8 private constant VERSION = 1;
    bytes32 private constant DEPLOYER_ROLE = 0xc806a955a4540a681430c702343887fec907f9e462be59f97b2cb3bcf01bb4bd; //keccak256("CREATE2.DEPLOYER.ROLE");
    error UpkeepRegistrationFailed();
    error BeaconNotFound();
    event ImplementationChanged(ContractType ct, address newImplementation);
    event Deployed(address newContract, bytes32 salt, ContractType ct);
    event SubscriptionCreated(uint256 subId);
    event Debug(string message);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(IVRFSubscriptionV2Plus vrfCoordinator_, IAutomationRegistrar2_1 keeperRegistry_, LinkTokenInterface linkToken_) external reinitializer(VERSION) {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DEPLOYER_ROLE, msg.sender);
        TalusFactoryStorage storage $ = _getFactoryStorage();
        $._vrfCoordinator = vrfCoordinator_;
        uint256 subId_ = vrfCoordinator_.createSubscription();
        $._subId = subId_;
        $._keeperRegistry = keeperRegistry_;
        $._linkToken = linkToken_;
        emit SubscriptionCreated(subId_);
    }

    function changeLogic(ContractType ct, address newImpl) external onlyRole(DEFAULT_ADMIN_ROLE) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        if (address($._beacons[ct]) == address(0)) {
            $._beacons[ct] = new UpgradeableBeacon(newImpl, address(this));
        } else {
            $._beacons[ct].upgradeTo(newImpl);
        }
        emit ImplementationChanged(ct, newImpl);
    }

    function createSubscription() external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        uint256 subId_ = $._vrfCoordinator.createSubscription();
        $._subId = subId_;
        emit SubscriptionCreated(subId_);
        return subId_;
    }

    function beacons(ContractType ct) external view returns (address) {
        return address(_getFactoryStorage()._beacons[ct]);
    }

    function subId() external view returns (uint256) {
        return _getFactoryStorage()._subId;
    }

    function upkeep(address gameContract) external view returns (Upkeep memory) {
        return _getFactoryStorage()._upkeeps[gameContract];
    }

    function addFunds(uint256[] memory amounts, bytes[] memory data) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 len = amounts.length;
        require(len == data.length, "Invalid lengths");
        TalusFactoryStorage storage $ = _getFactoryStorage();
        for (uint256 i; i < len; ) {
            $._linkToken.transferAndCall(address($._keeperRegistry), amounts[i], data[i]);
            unchecked {
                ++i;
            }
        }
    }

    // to remove unused consumer
    function changeCoordinator(IVRFSubscriptionV2Plus newCoordinator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        $._vrfCoordinator = newCoordinator;
    }

    // to remove unused consumer
    function removeConsumer(address consumer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        $._vrfCoordinator.removeConsumer($._subId, consumer);
    }

    function deploy(
        ContractType ct,
        bytes32 salt,
        bytes memory initializer
    ) external payable onlyProxy onlyRole(DEPLOYER_ROLE) returns (address) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        address beacon = address($._beacons[ct]);
        if (beacon == address(0)) revert BeaconNotFound();
        bytes memory bytecode = abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(beacon, new bytes(0)));
        address newContract = Create2.deploy(msg.value, salt, bytecode);
        emit Deployed(newContract, salt, ct);
        if (initializer.length > 0) {
            emit Debug("before initializer call");
            (bool success, ) = newContract.call(initializer);
            emit Debug(success ? "after initializer call: success" : "after initializer call: fail");
            require(success, "Init failed");
        }
        emit Debug("after initializer require");
        $._vrfCoordinator.addConsumer($._subId, newContract);
        address[] memory forwarders = new address[](2);
        uint256 customUpkeepId = $._keeperRegistry.registerUpkeep(IAutomationRegistrar2_1.RegistrationParams({
            name: "Talus-custom",
            encryptedEmail: new bytes(0),
            upkeepContract: newContract,
            gasLimit: 300000,
            adminAddress: address(this),
            triggerType: 0,
            checkData: new bytes(0),
            triggerConfig: new bytes(0),
            offchainConfig: new bytes(0),
            amount: 0.1 ether
        }));
        if (customUpkeepId == 0) revert UpkeepRegistrationFailed();
        uint256 logUpkeepId;
        if (ct != ContractType.TEAMFIGHT) {
            logUpkeepId = $._keeperRegistry.registerUpkeep(IAutomationRegistrar2_1.RegistrationParams({
                name: "Talus-log",
                encryptedEmail: new bytes(0),
                upkeepContract: newContract,
                gasLimit: uint32(block.gaslimit - 3000000),
                adminAddress: address(this),
                triggerType: 1,
                checkData: new bytes(1),
                triggerConfig: abi.encode(newContract, 0 /* filterSelector*/, RANDOM_SELECTOR /* Random(uint256,uint256) */, new bytes(0), new bytes(0), new bytes(0)),
                offchainConfig: new bytes(0),
                amount: 0.1 ether
            }));
            if (logUpkeepId == 0) revert UpkeepRegistrationFailed();
        }
        $._upkeeps[newContract] = Upkeep({ logUpkeepId: logUpkeepId, customUpkeepId: customUpkeepId });
        forwarders[0] = $._keeperRegistry.getForwarder(customUpkeepId);
        if (logUpkeepId > 0) forwarders[1] = $._keeperRegistry.getForwarder(logUpkeepId);
        else assembly {
            mstore(forwarders, 1) // set length to 1
        }
        IAutomationForwaderSetter(newContract).setForwarders(forwarders);
        return newContract;
    }

    function computeAddress(bytes32 salt, ContractType ct) external view onlyProxy returns (address) {
        TalusFactoryStorage storage $ = _getFactoryStorage();
        address beacon = address($._beacons[ct]);
        if (beacon == address(0)) revert BeaconNotFound();
        return Create2.computeAddress(salt, keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(beacon, new bytes(0)))));
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /**
     * @dev Returns a pointer to the storage namespace.
     */
    function _getFactoryStorage() private pure returns (TalusFactoryStorage storage $) {
        assembly {
            $.slot := ROULETTE_FACTORY_STORAGE
        }
    }
}
