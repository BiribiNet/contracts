// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev BRB stand-in for `BRBJackpotFunder` try/catch fee paths (transfer returns false, burn reverts).
contract MockBRBWithFeeHooks is ERC20Burnable {
    bool public failTransfer;
    bool public revertTransfer;
    bool public failBurn;

    constructor(address initialRecipient) ERC20("BIRIBI", "BRB") {
        _mint(initialRecipient, 1_000_000 * 10 ** 18);
    }

    function setFailTransfer(bool on) external {
        failTransfer = on;
    }

    function setRevertTransfer(bool on) external {
        revertTransfer = on;
    }

    function setFailBurn(bool on) external {
        failBurn = on;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (revertTransfer) revert();
        if (failTransfer) return false;
        return super.transfer(to, value);
    }

    function burn(uint256 value) public override {
        if (failBurn) revert();
        super.burn(value);
    }
}
