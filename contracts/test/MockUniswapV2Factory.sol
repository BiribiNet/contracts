// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MockUniswapV2Pair } from "./MockUniswapV2Pair.sol";

/// @dev CREATE2-free factory for tests: deploys pairs on demand.
contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) private _pair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (_pair[t0][t1] != address(0)) return _pair[t0][t1];
        pair = address(new MockUniswapV2Pair(tokenA, tokenB));
        _pair[t0][t1] = pair;
        _pair[t1][t0] = pair;
    }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return _pair[t0][t1];
    }
}
