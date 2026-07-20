// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC165 } from "./IERC165.sol";

/// @title IReceiver - receives keystone reports
/// @notice Implementations must support the IReceiver interface through ERC165.
interface IReceiver is IERC165 {
    /// @notice Handles incoming keystone reports.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
