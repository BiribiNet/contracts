// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAutomationRegistrar2_1 } from "./interfaces/IAutomationRegistrar2_1.sol";
import { IAutomationRegistry2_1 } from "./interfaces/IAutomationRegistry2_1.sol";
import { IUpkeepForwarderAuthority } from "./interfaces/IUpkeepForwarderAuthority.sol";

contract UpkeepManager is AccessControl, IUpkeepForwarderAuthority {
    bytes32 public constant REGISTRANT_ROLE = keccak256("REGISTRANT_ROLE");

    address public immutable LINK_TOKEN;
    address public immutable KEEPER_REGISTRAR;
    address public immutable KEEPER_REGISTRY;
    address public immutable UPKEEP_TARGET;

    /// @dev Automation forwarder address => registered upkeep id (`registerLaneUpkeep`).
    mapping(address => uint256) public forwarderToUpkeepId;

    error ZeroAddress();
    error ZeroAmount();
    error RegistrationFailed();

    event UpkeepRegistered(uint256 lane, uint256 upkeepId, address forwarder, uint96 amount);

    constructor(
        address linkToken,
        address keeperRegistrar,
        address keeperRegistry,
        address upkeepTarget,
        address admin,
        address initialRegistrant
    ) {
        if (
            linkToken == address(0) ||
            keeperRegistrar == address(0) ||
            keeperRegistry == address(0) ||
            upkeepTarget == address(0) ||
            admin == address(0)
        ) revert ZeroAddress();

        LINK_TOKEN = linkToken;
        KEEPER_REGISTRAR = keeperRegistrar;
        KEEPER_REGISTRY = keeperRegistry;
        UPKEEP_TARGET = upkeepTarget;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRANT_ROLE, admin);
        if (initialRegistrant != address(0)) {
            _grantRole(REGISTRANT_ROLE, initialRegistrant);
        }

        IERC20(linkToken).approve(keeperRegistrar, type(uint256).max);
    }

    /// @inheritdoc IUpkeepForwarderAuthority
    function isApprovedAutomationForwarder(address forwarder) external view returns (bool) {
        return forwarderToUpkeepId[forwarder] != 0;
    }

    function registerLaneUpkeep(
        uint256 lane,
        uint32 gasLimit,
        uint96 linkAmount,
        address upkeepAdmin
    ) external onlyRole(REGISTRANT_ROLE) returns (uint256 upkeepId) {
        if (linkAmount == 0) revert ZeroAmount();
        IERC20(LINK_TOKEN).transferFrom(msg.sender, address(this), linkAmount);

        upkeepId = IAutomationRegistrar2_1(KEEPER_REGISTRAR).registerUpkeep(
            IAutomationRegistrar2_1.RegistrationParams({
                name: "MultiAsset-Roulette-Lane",
                encryptedEmail: new bytes(0),
                upkeepContract: UPKEEP_TARGET,
                gasLimit: gasLimit,
                adminAddress: upkeepAdmin,
                triggerType: 0,
                checkData: lane == 0 ? new bytes(0) : abi.encode(lane),
                triggerConfig: new bytes(0),
                offchainConfig: new bytes(0),
                amount: linkAmount
            })
        );

        if (upkeepId == 0) revert RegistrationFailed();

        address forwarder = IAutomationRegistry2_1(KEEPER_REGISTRY).getForwarder(upkeepId);
        forwarderToUpkeepId[forwarder] = upkeepId;
        emit UpkeepRegistered(lane, upkeepId, forwarder, linkAmount);
    }
}
