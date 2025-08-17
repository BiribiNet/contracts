// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import { IAutomationRegistrar2_1 } from "./AutomationRegistrar2_1.sol";

contract MockKeeperRegistryReverting1 is IAutomationRegistrar2_1 {
    uint256 public lastId = 1;
    mapping(uint256 => address) public forwarders;
    address private immutable _owner;
    constructor() {
        _owner = msg.sender;
    }

    function registerUpkeep(RegistrationParams memory params) external returns (uint256) {
        if (lastId == 1) {
            return 0;
        }
        lastId++;
        forwarders[lastId] = params.upkeepContract;
        return lastId;
    }

    function getForwarder(uint256 /* id */) external view returns (address) {
        return _owner;
    }

    function onTokenTransfer(address, uint256, bytes calldata) external {
        // do nothing
    }
} 