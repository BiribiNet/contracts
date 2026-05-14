// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal EIP-2612 permit surface for try/catch compatibility.
interface IERC20PermitCompat {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
