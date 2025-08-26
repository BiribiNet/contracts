// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAutomationRegistry2_1 {
    function getForwarder(uint256 upkeepId) external view returns (address);
}