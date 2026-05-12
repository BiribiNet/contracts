// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBRBJackpotFunder {
    /// @notice Protocol BRB token (jackpot is always paid in this token).
    function brbToken() external view returns (address);

    /// @notice BPS of `marketWin` (asset) swapped to BRB in aggregate (e.g. 300 = 3%).
    function swapAssetTotalBps() external view returns (uint256);

    /// @notice Pulls `swapAssetTotalBps` of `marketWin` in `asset` from this contract balance, swaps to BRB when `asset != brb`, else splits BRB in-place; splits to treasury vs burn.
    function fundFromMarket(uint32 marketId, address asset, uint256 marketWin) external;

    /// @notice BRB per asset unit ratio (scaled by 1e18) used for minOut + share normalization.
    function brbPerAssetUnitRatio(uint32 marketId) external view returns (uint256);
}
