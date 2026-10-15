// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test router: 1 asset minimal unit (e.g. 1e-6 USDC) -> 1e12 BRB wei (1:1 at human scale).
contract MockUniswapV2Router {
    using SafeERC20 for IERC20;

    uint256 public constant BRB_PER_ASSET_UNIT = 1e12;

    address public factory;

    /// @dev WAD multiplier applied only in `getAmountsOut` (simulates stale / manipulated quotes).
    uint256 public quoteMultiplierWad;

    /// @dev Test hook: when true, swap reverts (e.g. funder try/catch paths).
    bool public forceRevertSwap;

    /// @dev Test hook: when true, `getAmountsOut` reverts (spot fallback catch path).
    bool public forceRevertGetAmountsOut;

    /// @dev Test hook: when true, `getAmountsOut` returns a one-element array (invalid quote path).
    bool public returnShortAmounts;

    constructor() {
        quoteMultiplierWad = 1e18;
    }

    function setFactory(address factory_) external {
        factory = factory_;
    }

    function setForceRevertSwap(bool on) external {
        forceRevertSwap = on;
    }

    function setForceRevertGetAmountsOut(bool on) external {
        forceRevertGetAmountsOut = on;
    }

    function setReturnShortAmounts(bool on) external {
        returnShortAmounts = on;
    }

    function setQuoteMultiplierWad(uint256 multiplierWad) external {
        quoteMultiplierWad = multiplierWad;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        if (forceRevertGetAmountsOut) revert();
        if (returnShortAmounts) {
            amounts = new uint256[](1);
            amounts[0] = amountIn;
            return amounts;
        }
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        if (path.length > 1) {
            amounts[1] = amountIn * BRB_PER_ASSET_UNIT * quoteMultiplierWad / 1e18;
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        if (forceRevertSwap) revert();
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
