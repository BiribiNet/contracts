// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal Uniswap V2 router surface for asset -> BRB swaps with slippage-protected quotes.
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /// @notice On-chain spot quote across `path`. Returns the cumulative amount-out at each hop.
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
