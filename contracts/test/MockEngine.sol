// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";

contract MockEngine {
    function recordBet(uint32, address, uint256, bytes calldata) external pure {}

    function releaseFromVault(address vault, uint256 amount) external {
        IBankVault(vault).releaseBets(amount);
    }

    function payoutFromVault(address vault, IBankVault.Payout[] calldata payouts) external returns (uint256 totalPaid) {
        return IBankVault(vault).payoutBatch(payouts);
    }
}
