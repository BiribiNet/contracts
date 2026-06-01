// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IBRBReferal } from "./interfaces/IBRBReferal.sol";

/// @notice Referral ledger token (BRBR). Only `RouletteEngine` may mint rewards.
contract BRBReferal is ERC20, IBRBReferal {
    address private immutable ROULETTE_ENGINE;

    constructor(address rouletteEngine) ERC20("BiRiBi Referral", "BRBR") {
        if (rouletteEngine == address(0)) revert Unauthorized();
        ROULETTE_ENGINE = rouletteEngine;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != ROULETTE_ENGINE) revert Unauthorized();
        _mint(to, amount);
    }
}
