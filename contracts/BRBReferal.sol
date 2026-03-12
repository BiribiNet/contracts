// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC677Receiver } from "./interfaces/IERC677.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract BRBReferal is ERC20 {
    error Unauthorized();
    address private immutable STAKED_BRB_CONTRACT;
    constructor(address stakedBRBContract) ERC20("BiRiBi Referral", "BRBR") {
        STAKED_BRB_CONTRACT = stakedBRBContract;
    }

    function mint(address to, uint256 amount) external {
       require(msg.sender == STAKED_BRB_CONTRACT, Unauthorized());
       _mint(to, amount);
    }
}