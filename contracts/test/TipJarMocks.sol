// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITipMockTarget { function tip(uint256 amount) external; }

contract TipEngineMock {
    address public INFRA_RECIPIENT;
    constructor(address recipient) { INFRA_RECIPIENT = recipient; }
}

contract TipTokenMock is ERC20 {
    bool public tax;
    address public reentry;
    bool public falseReturn;
    constructor() ERC20("Tip test", "TIP") { _mint(msg.sender, 1_000 ether); }
    function setTax(bool value) external { tax = value; }
    function setReentry(address target) external { reentry = target; }
    function setFalseReturn(bool value) external { falseReturn = value; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (reentry != address(0)) ITipMockTarget(reentry).tip(amount);
        if (falseReturn) return false;
        return super.transferFrom(from, to, amount);
    }
    function _update(address from, address to, uint256 value) internal override {
        if (tax && from != address(0) && to != address(0)) {
            super._update(from, address(0), value / 10);
            value -= value / 10;
        }
        super._update(from, to, value);
    }
}
