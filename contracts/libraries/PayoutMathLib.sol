// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

library PayoutMathLib {
    uint256 internal constant BPS = 10_000;

    function capPayoutByPool(uint256 requested, uint256 pool) internal pure returns (uint256) {
        return requested > pool ? pool : requested;
    }

    function percentOf(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / BPS;
    }
}
