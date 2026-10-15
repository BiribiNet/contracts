// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";

/// @dev Calls back into the vault during `recordBet` to exercise `nonReentrant` on `_placeBetCore`.
contract MockEngineReentrant {
    address public vault;
    bool public reenter;

    function setVault(address vault_) external {
        vault = vault_;
    }

    function setReenter(bool on) external {
        reenter = on;
    }

    function recordBet(uint32, address, uint256 amount, bytes calldata betData, address referral) external {
        if (reenter && vault != address(0)) {
            IBankVault(vault).placeBet(amount, betData, referral);
        }
    }

    function currentGlobalRound() external pure returns (uint64) {
        return 1;
    }

    function isBankLiquidityRestricted(uint32) external pure returns (bool) {
        return false;
    }

    function marketRouletteLiquidityNeed(uint32) external pure returns (uint256) {
        return 0;
    }

    function maxWithdrawalQueueLength() external pure returns (uint256) {
        return 1000;
    }

    function processWithdrawals(address vault_, uint256 maxCount) external returns (uint256 processed) {
        return IBankVault(vault_).processWithdrawalQueue(maxCount);
    }

    function transferOutFromVault(address vault_, address recipient, uint256 amount) external {
        IBankVault(vault_).transferOut(recipient, amount);
    }
}
