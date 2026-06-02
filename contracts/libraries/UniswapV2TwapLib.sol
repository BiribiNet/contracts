// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IUniswapV2Pair } from "../vendor/uniswap-v2-core/interfaces/IUniswapV2Pair.sol";

/// @dev Uniswap V2 TWAP helpers (cumulative price oracles). See https://docs.uniswap.org/contracts/v2/concepts/core-concepts/oracles
library UniswapV2TwapLib {
    uint256 private constant Q112 = 1 << 112;

    /// @dev Canonical Uniswap V2 pair init code hash (matches vendored `UniswapV2Factory` in this repo).
    bytes32 private constant PAIR_INIT_CODE_HASH =
        0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    struct Observation {
        uint32 timestamp;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }

    function pairFor(address factory, address tokenA, address tokenB) internal pure returns (address pair) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(hex"ff", factory, keccak256(abi.encodePacked(token0, token1)), PAIR_INIT_CODE_HASH))
                )
            )
        );
    }

    /// @notice Extrapolates cumulative prices to the current block (same pattern as Uniswap periphery oracle samples).
    function currentCumulativePrices(address pair)
        internal
        view
        returns (uint256 price0Cumulative, uint256 price1Cumulative, uint32 blockTimestamp)
    {
        blockTimestamp = uint32(block.timestamp);
        IUniswapV2Pair uniPair = IUniswapV2Pair(pair);
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = uniPair.getReserves();
        price0Cumulative = uint256(uniPair.price0CumulativeLast());
        price1Cumulative = uint256(uniPair.price1CumulativeLast());
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && reserve0 != 0 && reserve1 != 0) {
                price0Cumulative += (uint256(reserve1) * Q112 / uint256(reserve0)) * timeElapsed;
                price1Cumulative += (uint256(reserve0) * Q112 / uint256(reserve1)) * timeElapsed;
            }
        }
    }

    /// @dev TWAP output for `amountIn` of `tokenIn` sold for the other pair token, using stored `obs` as the window start.
    function quoteTwapAmountOut(
        address pair,
        address tokenIn,
        uint256 amountIn,
        Observation memory obs,
        uint32 nowTimestamp
    ) internal view returns (uint256 amountOut) {
        if (obs.timestamp == 0 || nowTimestamp <= obs.timestamp || amountIn == 0) return 0;

        (uint256 price0CumulativeNow, uint256 price1CumulativeNow,) = currentCumulativePrices(pair);
        address token0 = IUniswapV2Pair(pair).token0();
        uint32 timeElapsed = nowTimestamp - obs.timestamp;
        unchecked {
            if (tokenIn == token0) {
                uint256 price0Delta = price0CumulativeNow - obs.price0Cumulative;
                if (price0Delta == 0) return 0;
                uint224 price0Average = uint224(price0Delta / timeElapsed);
                amountOut = (amountIn * uint256(price0Average)) >> 112;
            } else {
                uint256 price1Delta = price1CumulativeNow - obs.price1Cumulative;
                if (price1Delta == 0) return 0;
                uint224 price1Average = uint224(price1Delta / timeElapsed);
                amountOut = (amountIn * uint256(price1Average)) >> 112;
            }
        }
    }

    /// @dev Constant-product spot output (997/1000 fee), used before TWAP window is warm or as fallback.
    function spotAmountOut(address pair, address tokenIn, uint256 amountIn) internal view returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        IUniswapV2Pair uniPair = IUniswapV2Pair(pair);
        (uint112 reserve0, uint112 reserve1,) = uniPair.getReserves();
        address token0 = uniPair.token0();
        (uint256 reserveIn, uint256 reserveOut) =
            tokenIn == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        if (reserveIn == 0 || reserveOut == 0) return 0;
        unchecked {
            uint256 amountInWithFee = amountIn * 997;
            amountOut = amountInWithFee * reserveOut / (reserveIn * 1000 + amountInWithFee);
        }
    }
}
