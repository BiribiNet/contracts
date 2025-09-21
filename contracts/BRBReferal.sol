// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC677Receiver } from "./interfaces/IERC677.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract BRBReferal is ERC20 {
    error Unauthorized();
    address private immutable ROULETTE_CONTRACT;
    constructor() ERC20("BiRiBi Referral", "BRBR") {
        ROULETTE_CONTRACT = msg.sender;
    }

    function mint(address to, uint256 amount) external {
       require(msg.sender == ROULETTE_CONTRACT, Unauthorized());
       _mint(to, amount);
    }
}