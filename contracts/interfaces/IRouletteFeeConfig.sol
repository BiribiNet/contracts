// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Fee routing addresses exposed by `RouletteEngine` for modules such as `SideBet`.
interface IRouletteFeeConfig {
    function JACKPOT_FUNDER() external view returns (address);
    function INFRA_RECIPIENT() external view returns (address);
}
