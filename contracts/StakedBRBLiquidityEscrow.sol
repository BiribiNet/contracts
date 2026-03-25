// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Holds BRB for queued vault deposits/mints until StakedBRB settles or refunds them.
 * @dev User approves StakedBRB; StakedBRB moves BRB here on enqueue and pulls it back on settlement.
 * @dev BRB reverts on failure; no SafeERC20.
 */
contract StakedBRBLiquidityEscrow {
    IERC20 public immutable BRB;
    address public immutable STAKED_VAULT;

    error OnlyVault();
    error ZeroAddress();

    modifier onlyVault() {
        if (msg.sender != STAKED_VAULT) revert OnlyVault();
        _;
    }

    constructor(address brb, address stakedVault) {
        if (brb == address(0) || stakedVault == address(0)) revert ZeroAddress();
        BRB = IERC20(brb);
        STAKED_VAULT = stakedVault;
    }

    function pushToVault(uint256 amount) external onlyVault {
        BRB.transfer(STAKED_VAULT, amount);
    }

    function refund(address to, uint256 amount) external onlyVault {
        BRB.transfer(to, amount);
    }
}
