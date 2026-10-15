// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Asset with decimals > 77 for {BankVault4626} initialize guard tests.
contract MockTokenHighDecimals is ERC20 {
    constructor() ERC20("HighDec", "HD") {
        _mint(msg.sender, 1e30);
    }

    function decimals() public pure override returns (uint8) {
        return 78;
    }
}
