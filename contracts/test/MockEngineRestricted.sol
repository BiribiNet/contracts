// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockEngineRestricted {
    function recordBet(uint32, address, uint256, bytes calldata, address) external pure {}

    function isBankLiquidityRestricted(uint32) external pure returns (bool) {
        return true;
    }

    function maxWithdrawalQueueLength() external pure returns (uint256) {
        return 0;
    }
}

