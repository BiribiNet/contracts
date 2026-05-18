// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBRBJackpotFunder {
    /// @notice Protocol BRB token (jackpot is always paid in this token).
    function brbToken() external view returns (address);

    /// @notice BPS the engine uses against per-round profit to size `transferOut` before `fundFromMarket` (e.g. 300 = 3%). The funder swaps its full on-hand `asset` balance.
    function swapAssetTotalBps() external view returns (uint256);

    /// @notice Swaps the funder's entire `asset` balance to BRB when `asset != brb`, else splits that BRB in-place; treasury receives its BRB share, remainder is burned (supply reduction). The engine must `transferOut` the intended slice before calling.
    /// @dev Engine-only. Does not revert on swap failure, failed treasury transfer, or failed burn (emits / try-catch) so upkeep settlement cannot brick on those paths.
    function fundFromMarket(uint32 marketId, address asset) external;
}
