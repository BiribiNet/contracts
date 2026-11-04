// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";

interface IWithdrawalHatch { function drainWithdrawalQueue(uint256 maxCount) external returns (uint256); }

contract RouletteDrainAttempt {
    function deposit(address token, address bank, uint256 assets) external {
        IERC20(token).transferFrom(msg.sender, address(this), assets);
        IERC20(token).approve(bank, type(uint256).max);
        IERC4626(bank).deposit(assets, address(this));
    }
    function betThenDrain(address token, address bank, uint256 stake, bytes calldata betData) external {
        IERC20(token).transferFrom(msg.sender, address(this), stake);
        IBankVault(bank).placeBet(stake, betData, address(0));
        IBankVault(bank).redeemBps(10_000, address(this), address(this));
        IWithdrawalHatch(bank).drainWithdrawalQueue(10);
    }
}
