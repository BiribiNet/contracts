// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBRBReferal {
    error Unauthorized();

    function mint(address to, uint256 amount) external;
}
