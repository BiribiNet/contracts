// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC677Receiver } from "./interfaces/IERC677.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IRoulette } from "./interfaces/IRoulette.sol";

contract BRB is ERC20, ERC20Permit {
    error BRBLengthMismatch();
    error ZeroAddressPayout();
    constructor() ERC20("BiRiBi", "BRB") ERC20Permit("BiRiBi") {
        _mint(msg.sender, 30_000_000 * 10 ** decimals());
    }

    function bet(IERC677Receiver to, uint256 amount, bytes calldata data, address referral) external {
        _transfer(msg.sender, address(to), amount);
        to.onTokenTransfer(msg.sender, amount, data, referral);
    }

    function transferBatch(IRoulette.PayoutInfo[] calldata payouts) external {
        uint256 payoutsLength = payouts.length;
        IRoulette.PayoutInfo memory payoutInfo;
        for (uint256 i; i < payoutsLength;) {
            payoutInfo = payouts[i];
            if (payoutInfo.player == address(0)) revert ZeroAddressPayout();
            _transfer(msg.sender, payoutInfo.player, payoutInfo.payout);
            unchecked { ++i; }
        }
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}