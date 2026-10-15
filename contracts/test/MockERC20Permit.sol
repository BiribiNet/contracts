// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev USDC-like token with EIP-2612 for permit tests.
contract MockERC20Permit is ERC20Permit {
    constructor() ERC20("Permit Mock", "PM") ERC20Permit("Permit Mock") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
