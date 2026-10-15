// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Holds Uniswap V2 LP tokens until a fixed 3-year cliff, then beneficiary may withdraw.
contract LPVestingLock is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant BENEFICIARY_ROLE = keccak256("BENEFICIARY_ROLE");

    IERC20 public immutable lpToken;
    uint256 public immutable cliff;

    error ZeroAddress();
    error LockNotElapsed();
    error ZeroAmount();
    error AmountExceedsBalance();

    event Released(address to, uint256 amount);

    constructor(address lpToken_, address beneficiary, address admin) {
        if (lpToken_ == address(0) || beneficiary == address(0) || admin == address(0)) revert ZeroAddress();
        lpToken = IERC20(lpToken_);
        cliff = block.timestamp + 3 * 365 days;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BENEFICIARY_ROLE, beneficiary);
    }

    /// @notice After cliff, transfers entire LP balance to `to`.
    function release(address to) external onlyRole(BENEFICIARY_ROLE) {
        _release(to, lpToken.balanceOf(address(this)));
    }

    /// @notice After cliff, transfers `amount` of LP tokens to `to`.
    function release(address to, uint256 amount) external onlyRole(BENEFICIARY_ROLE) {
        _release(to, amount);
    }

    function _release(address to, uint256 amount) internal {
        if (block.timestamp < cliff) revert LockNotElapsed();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > lpToken.balanceOf(address(this))) revert AmountExceedsBalance();
        lpToken.safeTransfer(to, amount);
        emit Released(to, amount);
    }
}
