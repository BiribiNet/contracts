// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC677Receiver } from "../interfaces/IERC677.sol";

contract MockERC677Receiver is IERC677Receiver {
    address public lastSender;
    uint256 public lastValue;
    bytes public lastData;
    address public lastReferral;

    function onTokenTransfer(address sender, uint256 value, bytes calldata data, address referral) external override {
        lastSender = sender;
        lastValue = value;
        lastData = data;
        lastReferral = referral;
    }
}
