// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal Uniswap V2 pair for TWAP / slippage tests (not a full AMM).
contract MockUniswapV2Pair {
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_) {
        (token0, token1) = token0_ < token1_ ? (token0_, token1_) : (token1_, token0_);
        blockTimestampLast = uint32(block.timestamp);
    }

    function setReserves(uint112 r0, uint112 r1) external {
        _updateCumulative();
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _updateCumulative() private {
        uint32 timeElapsed = uint32(block.timestamp) - blockTimestampLast;
        if (timeElapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            uint256 q112 = 1 << 112;
            price0CumulativeLast += (uint256(reserve1) * q112 / reserve0) * timeElapsed;
            price1CumulativeLast += (uint256(reserve0) * q112 / reserve1) * timeElapsed;
        }
        blockTimestampLast = uint32(block.timestamp);
    }
}
