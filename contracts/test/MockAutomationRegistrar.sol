// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockAutomationRegistrar {
    uint256 private _nextUpkeepId = 1;
    
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
        uint96 amount;
    }
    
    mapping(uint256 => address) public upkeepForwarders;
    
    function registerUpkeep(RegistrationParams calldata /* params */) external returns (uint256) {
        uint256 upkeepId = _nextUpkeepId++;
        
        // Generate a mock forwarder address (just increment from a base)
        address forwarder = address(uint160(uint256(keccak256(abi.encode(upkeepId))) >> 96));
        upkeepForwarders[upkeepId] = forwarder;
        
        return upkeepId;
    }
    
    function getForwarder(uint256 upkeepId) external view returns (address) {
        return upkeepForwarders[upkeepId];
    }
}

contract MockAutomationRegistry {
    MockAutomationRegistrar public immutable registrar;
    
    constructor() {
        registrar = new MockAutomationRegistrar();
    }
    
    function getForwarder(uint256 upkeepId) external view returns (address) {
        return registrar.getForwarder(upkeepId);
    }
}
