// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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