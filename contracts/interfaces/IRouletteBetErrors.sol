// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Shared bet validation errors for `RouletteEngine` and linked `RouletteBetCodecLib`.
interface IRouletteBetErrors {
    error InvalidBetType();
    error InvalidBetNumber();
}
