// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ReceiverTemplate } from "./ReceiverTemplate.sol";

/// @title AutomationReceiver
/// @notice CRE bridge that forwards approved calls to legacy Automation upkeep targets.
contract AutomationReceiver is ReceiverTemplate {
    mapping(address target => mapping(bytes4 selector => bool allowed)) private s_callAllowed;

    event CallExecuted(address indexed target, bytes4 indexed selector, bytes returnData);
    event CallFailed(address indexed target, bytes4 indexed selector, bytes reason);
    event CallAllowedSet(address indexed target, bytes4 indexed selector, bool allowed);

    error InvalidTargetAddress();
    error MissingSelector();
    error CallNotAllowed(address target, bytes4 selector);

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    function setCallAllowed(address target, bytes4 selector, bool allowed) external onlyOwner {
        if (target == address(0)) revert InvalidTargetAddress();
        s_callAllowed[target][selector] = allowed;
        emit CallAllowedSet(target, selector, allowed);
    }

    function isCallAllowed(address target, bytes4 selector) external view returns (bool) {
        return s_callAllowed[target][selector];
    }

    function _processReport(bytes calldata report) internal override {
        (address target, bytes memory data) = abi.decode(report, (address, bytes));

        if (target == address(0)) revert InvalidTargetAddress();
        if (data.length < 4) revert MissingSelector();

        bytes4 selector;
        assembly {
            selector := mload(add(data, 0x20))
        }
        if (!s_callAllowed[target][selector]) {
            revert CallNotAllowed(target, selector);
        }

        (bool success, bytes memory returnData) = target.call(data);
        if (success) {
            emit CallExecuted(target, selector, returnData);
        } else {
            emit CallFailed(target, selector, returnData);
        }
    }
}
