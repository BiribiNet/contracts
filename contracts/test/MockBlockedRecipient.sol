// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Models a supported token that rejects transfers to a blocked recipient.
contract MockBlockedRecipient is ERC20 {
    mapping(address => bool) public blocked;
    error BlockedRecipient();
    constructor() ERC20("Blocked recipient mock", "BLOCK") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function _update(address from, address to, uint256 amount) internal override {
        if (blocked[to]) revert BlockedRecipient();
        super._update(from, to, amount);
    }
}
