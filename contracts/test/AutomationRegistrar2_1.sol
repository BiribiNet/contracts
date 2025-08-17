// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IAutomationRegistrar2_1 {
    function registerUpkeep(RegistrationParams calldata params) external returns (uint256);

    function getForwarder(uint256 upkeepID) external view returns (address); 
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
}
