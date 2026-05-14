// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBankVault {
    struct Payout {
        address player;
        uint256 amount;
    }

    struct QueuedWithdrawal {
        /// @dev 0 = none, 1 = withdraw(assets), 2 = redeem(shares)
        uint8 kind;
        address receiver;
        uint256 assets;
        uint256 shares;
    }

    function marketId() external view returns (uint32);

    function minBet() external view returns (uint256);

    function placeBet(uint256 amount, bytes calldata betData) external;

    function placeBetWithPermit(
        uint256 amount,
        bytes calldata betData,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function releaseBets(uint256 amount) external;

    function payoutBatch(Payout[] calldata payouts) external returns (uint256 totalPaid);

    function transferOut(address recipient, uint256 amount) external;

    /// @notice Queue a withdrawal (assets) to be finalized after round settlement.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /// @notice Queue a redemption (shares) to be finalized after round settlement.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Cancel the caller's pending queued withdrawal (if any).
    function cancelWithdrawal() external;

    /// @notice Processes up to `maxCount` queued withdrawals; engine-only.
    function processWithdrawalQueue(uint256 maxCount) external returns (uint256 processed);
}
