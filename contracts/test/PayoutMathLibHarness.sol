// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { PayoutMathLib } from "../libraries/PayoutMathLib.sol";

contract PayoutMathLibHarness {
    function capPayoutByPool(uint256 requested, uint256 pool) external pure returns (uint256) {
        return PayoutMathLib.capPayoutByPool(requested, pool);
    }

    function percentOf(uint256 amount, uint256 bps) external pure returns (uint256) {
        return PayoutMathLib.percentOf(amount, bps);
    }
}
