// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AutomationReceiver } from "../chainlink/cre/AutomationReceiver.sol";

/// @dev Test double that delivers CRE reports to `AutomationReceiver` without the real KeystoneForwarder.
contract MockCreForwarder {
    function deliverReport(AutomationReceiver receiver, bytes calldata report) external {
        receiver.onReport("", report);
    }
}
