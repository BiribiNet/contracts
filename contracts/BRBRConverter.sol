// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IBRBRConverter } from "./interfaces/IBRBRConverter.sol";

/// @title BRBRConverter
/// @notice Converts BRBR (referral) tokens to BRB at a configurable rate.
/// @dev BRBR tokens are transferred into this contract permanently (no public burn on BRBReferral).
///      The converter must be pre-funded with BRB reserves by the admin.
///      Rate is expressed as BRBR per 1 BRB, scaled by 1e18. For example, a rate of 100e18
///      means 100 BRBR converts to 1 BRB.
contract BRBRConverter is IBRBRConverter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────── State

    /// @notice The BRB token
    IERC20 public immutable BRB;

    /// @notice The BRBR (referral) token
    IERC20 public immutable BRBR;

    /// @notice Conversion rate: BRBR per 1 BRB, scaled by 1e18
    /// @dev E.g., 100e18 means 100 BRBR = 1 BRB
    uint256 public rate;

    // ──────────────────────────────────────────────── Constructor

    /// @param brb Address of the BRB token
    /// @param brbr Address of the BRBR (referral) token
    /// @param initialRate Initial conversion rate (BRBR per 1 BRB, scaled by 1e18)
    /// @param admin Address that will own the contract
    constructor(
        address brb,
        address brbr,
        uint256 initialRate,
        address admin
    ) Ownable(admin) {
        if (initialRate == 0) revert BRBRConverter__ZeroRate();
        BRB = IERC20(brb);
        BRBR = IERC20(brbr);
        rate = initialRate;
    }

    // ──────────────────────────────────────────────── Conversion

    /// @inheritdoc IBRBRConverter
    function convert(uint256 brbrAmount) external nonReentrant {
        if (brbrAmount == 0) revert BRBRConverter__ZeroAmount();

        // Calculate BRB output: brbrAmount * 1e18 / rate
        uint256 brbOut = (brbrAmount * 1e18) / rate;
        if (brbOut == 0) revert BRBRConverter__ZeroAmount();
        if (BRB.balanceOf(address(this)) < brbOut) revert BRBRConverter__InsufficientBRBReserves();

        // CEI: effects before interactions
        // (no internal state to update beyond the token balances)

        // Interactions: pull BRBR from user, push BRB to user
        BRBR.safeTransferFrom(msg.sender, address(this), brbrAmount);
        BRB.safeTransfer(msg.sender, brbOut);

        emit Converted(msg.sender, brbrAmount, brbOut);
    }

    /// @inheritdoc IBRBRConverter
    function quote(uint256 brbrAmount) external view returns (uint256 brbAmount) {
        brbAmount = (brbrAmount * 1e18) / rate;
    }

    // ──────────────────────────────────────────────── Admin: Rate

    /// @inheritdoc IBRBRConverter
    function setRate(uint256 newRate) external onlyOwner {
        if (newRate == 0) revert BRBRConverter__ZeroRate();
        uint256 oldRate = rate;
        rate = newRate;
        emit RateUpdated(oldRate, newRate);
    }

    // ──────────────────────────────────────────────── Admin: Reserves

    /// @inheritdoc IBRBRConverter
    function fund(uint256 amount) external {
        if (amount == 0) revert BRBRConverter__ZeroAmount();
        BRB.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @inheritdoc IBRBRConverter
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert BRBRConverter__ZeroAmount();
        BRB.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @inheritdoc IBRBRConverter
    function brbReserves() external view returns (uint256) {
        return BRB.balanceOf(address(this));
    }
}
