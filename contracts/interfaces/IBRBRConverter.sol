// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IBRBRConverter
/// @notice Interface for the BRBR-to-BRB converter contract
interface IBRBRConverter {
    // ──────────────────────────────────────────────── Errors
    error BRBRConverter__ZeroAmount();
    error BRBRConverter__InsufficientBRBReserves();
    error BRBRConverter__ZeroRate();
    error BRBRConverter__Unauthorized();

    // ──────────────────────────────────────────────── Events

    /// @notice Emitted when a user converts BRBR to BRB
    /// @param user The address that performed the conversion
    /// @param brbrBurned Amount of BRBR transferred to the converter (effectively burned)
    /// @param brbReceived Amount of BRB sent to the user
    event Converted(address indexed user, uint256 brbrBurned, uint256 brbReceived);

    /// @notice Emitted when the conversion rate is updated
    /// @param oldRate Previous rate (BRBR per 1 BRB, scaled by 1e18)
    /// @param newRate New rate (BRBR per 1 BRB, scaled by 1e18)
    event RateUpdated(uint256 oldRate, uint256 newRate);

    /// @notice Emitted when the admin funds the converter with BRB
    /// @param funder Address that funded the converter
    /// @param amount Amount of BRB deposited
    event Funded(address indexed funder, uint256 amount);

    /// @notice Emitted when the admin withdraws excess BRB
    /// @param to Recipient of the withdrawn BRB
    /// @param amount Amount of BRB withdrawn
    event Withdrawn(address indexed to, uint256 amount);

    // ──────────────────────────────────────────────── Functions

    /// @notice Converts BRBR tokens to BRB at the current rate
    /// @param brbrAmount Amount of BRBR to convert
    /// @dev Caller must approve the converter to spend their BRBR first.
    ///      BRBR is transferred to the converter (held permanently). BRB is sent to caller.
    function convert(uint256 brbrAmount) external;

    /// @notice Returns the amount of BRB a user would receive for a given BRBR amount
    /// @param brbrAmount Amount of BRBR to quote
    /// @return brbAmount Amount of BRB the user would receive
    function quote(uint256 brbrAmount) external view returns (uint256 brbAmount);

    /// @notice Updates the conversion rate
    /// @param newRate New rate expressed as BRBR per 1 BRB (scaled by 1e18)
    /// @dev Only callable by admin. E.g., 100e18 means 100 BRBR = 1 BRB.
    function setRate(uint256 newRate) external;

    /// @notice Funds the converter with BRB tokens
    /// @param amount Amount of BRB to deposit
    /// @dev Caller must approve the converter to spend their BRB first.
    function fund(uint256 amount) external;

    /// @notice Withdraws excess BRB from the converter
    /// @param to Recipient address
    /// @param amount Amount of BRB to withdraw
    /// @dev Only callable by admin.
    function withdraw(address to, uint256 amount) external;

    /// @notice Returns the current conversion rate (BRBR per 1 BRB, scaled by 1e18)
    function rate() external view returns (uint256);

    /// @notice Returns the BRB reserves available for conversions
    function brbReserves() external view returns (uint256);
}
