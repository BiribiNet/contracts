// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IJackpotContract {
    function jackpotWin(address[] memory winners, uint256 winnerShare) external;
}