// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal target for `ProtocolTimelock` tests.
contract MockTimelockCallee {
    uint256 public x;
    uint256 public lastReceived;

    function setX(uint256 v) external {
        x = v;
    }

    receive() external payable {
        lastReceived = msg.value;
    }
}
