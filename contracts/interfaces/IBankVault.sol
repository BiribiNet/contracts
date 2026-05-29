// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IBankVault {
    struct Payout {
        address player;
        uint256 amount;
    }

    struct QueuedWithdrawal {
        /// @dev 0 = none; otherwise fraction of the owner's vault shares in basis points (10_000 = 100%).
        uint16 bps;
        address receiver;
    }

    function marketId() external view returns (uint32);

    function minBet() external view returns (uint256);

    function assetDecimals() external view returns (uint8);

    function flatWithdrawFee() external view returns (uint256);

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

    /// @notice Queue a fraction of the owner's position (derived from `assets`) to settle after round resolution.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /// @notice Queue a fraction of the owner's position (derived from `shares`) to settle after round resolution.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Queue `bps` basis points (10_000 = 100%) of the owner's position.
    function redeemBps(uint16 bps, address receiver, address owner) external returns (uint256 assets);

    /// @notice Processes up to `maxCount` queued withdrawals; engine-only.
    function processWithdrawalQueue(uint256 maxCount) external returns (uint256 processed);
}
