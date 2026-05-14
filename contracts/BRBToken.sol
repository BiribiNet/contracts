// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title BRB — Biribi protocol token (full supply minted once at deploy).
contract BRBToken is ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 3_000_000 * 10 ** 18;

    constructor(address initialRecipient) ERC20("BIRIBI", "BRB") ERC20Permit("BIRIBI") {
        _mint(initialRecipient, TOTAL_SUPPLY);
    }
}
