// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RoutedBRBJackpotFunder } from "../RoutedBRBJackpotFunder.sol";

/// @dev Test-only introspection. No additional production privileges or setters.
contract RoutedBRBJackpotFunderHarness is RoutedBRBJackpotFunder {
    constructor(address engine_, address brb_, address router_, address treasury_, address sideBet_,
        address admin_, address routed_, address bridge_)
        RoutedBRBJackpotFunder(engine_, brb_, router_, treasury_, sideBet_, admin_, routed_, bridge_) {}

    function inputCap(address asset) external view returns (uint256) {
        return _routeInputCap(fundingPath(asset));
    }

    function minimumOutput(address asset, uint256 amount) external view returns (uint256) {
        return _amountOutMin(amount, fundingPath(asset));
    }
}
