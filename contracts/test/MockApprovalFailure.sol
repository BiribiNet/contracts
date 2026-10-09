// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;
import { MockUSDC } from "./MockUSDC.sol";
contract MockApprovalFailure is MockUSDC {
    function approve(address, uint256) public pure override returns (bool) { revert("approval unavailable"); }
}
