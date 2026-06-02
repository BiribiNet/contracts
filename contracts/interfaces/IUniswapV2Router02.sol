// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal Uniswap V2 router surface for asset -> BRB swaps.
interface IUniswapV2Router02 {
    function factory() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
