// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBankVault {
    struct Payout {
        address player;
        uint256 amount;
    }

    function marketId() external view returns (uint32);


    function placeBet(uint256 amount, bytes calldata betData) external;

    function releaseBets(uint256 amount) external;

    function payoutBatch(Payout[] calldata payouts) external returns (uint256 totalPaid);

    function transferOut(address recipient, uint256 amount) external;
}
