// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test router: 1 asset minimal unit (e.g. 1e-6 USDC) -> 1e12 BRB wei (1:1 at human scale).
contract MockUniswapV2Router {
    using SafeERC20 for IERC20;

    uint256 public constant BRB_PER_ASSET_UNIT = 1e12;

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        IERC20 asset = IERC20(path[0]);
        IERC20 brb = IERC20(path[path.length - 1]);
        asset.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * BRB_PER_ASSET_UNIT;
        require(out >= amountOutMin, "minOut");
        brb.safeTransfer(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}
