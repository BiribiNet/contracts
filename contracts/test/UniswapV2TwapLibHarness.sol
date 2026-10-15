// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { UniswapV2TwapLib } from "../libraries/UniswapV2TwapLib.sol";

contract UniswapV2TwapLibHarness {
    function pairFor(address factory, address tokenA, address tokenB) external pure returns (address) {
        return UniswapV2TwapLib.pairFor(factory, tokenA, tokenB);
    }
}
