// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBRBJackpotFunder {
    /// @notice Record the exact transferred fee without executing external swaps.
    function queueFunding(uint32 marketId, address asset, uint256 amount) external;
    /// @notice Protocol BRB token (jackpot is always paid in this token).
    function brbToken() external view returns (address);

    /// @notice BPS the collector uses to size the input fee before transfer and queue credit.
    function swapAssetTotalBps() external view returns (uint256);

    /// @notice Deprecated synchronous collector path; never consumes another market's credited input.
    /// @dev New collectors use queueFunding; all external execution belongs to processFunding.
    function fundFromMarket(uint32 marketId, address asset) external;
}
