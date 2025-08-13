// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract BRB is ERC20 {
    constructor() ERC20("BiRiBi", "BRB") {
        _mint(msg.sender, 30_000_000 * 10 ** decimals());
    }
}