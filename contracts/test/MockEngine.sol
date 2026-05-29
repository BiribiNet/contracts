// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";

contract MockEngine {
    function recordBet(uint32, address, uint256, bytes calldata) external pure {}

    /// @dev Stub for legacy-shaped `BetPlaced` emission in {BankVault4626}.
    function currentGlobalRound() external pure returns (uint64) {
        return 1;
    }

    /// @dev Stub for {BankVault4626} liquidity checks in unit tests (real engine derives this from round state).
    function isBankLiquidityRestricted(uint32) external pure returns (bool) {
        return false;
    }

    /// @dev Stub matching default engine cap for queue-length checks in unit tests.
    function maxWithdrawalQueueLength() external pure returns (uint256) {
        return 1000;
    }

    function releaseFromVault(address vault, uint256 amount) external {
        IBankVault(vault).releaseBets(amount);
    }

    function payoutFromVault(address vault, IBankVault.Payout[] calldata payouts) external returns (uint256 totalPaid) {
        return IBankVault(vault).payoutBatch(payouts);
    }

    function processWithdrawals(address vault, uint256 maxCount) external returns (uint256 processed) {
        return IBankVault(vault).processWithdrawalQueue(maxCount);
    }

    function transferOutFromVault(address vault, address recipient, uint256 amount) external {
        IBankVault(vault).transferOut(recipient, amount);
    }
}
