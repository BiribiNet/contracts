// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IJackpotTreasury {
    /// @notice Pays explicit BRB amounts to winners (engine computes shares).
    function payBatch(address[] calldata winners, uint256[] calldata amounts) external returns (uint256 paid);

    function jackpotPool() external view returns (uint256);
}
