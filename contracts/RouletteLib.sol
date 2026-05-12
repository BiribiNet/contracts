// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Linked library: worst-case liability math used by `RouletteEngine` (deployed separately to stay under EIP-170).
/// @dev Legacy helpers (`getWinningBetTypes`, `maxLiabilityRaw`, etc.) live in `references/` or `RouletteBetLib`; do not duplicate here.
library RouletteLib {
    uint256 internal constant SAFETY_BUFFER_BPS = 11000;

    function _max(uint256 x, uint256 y) private pure returns (uint256 z) {
        /// @solidity memory-safe-assembly
        assembly {
            z := xor(x, mul(xor(x, y), gt(y, x)))
        }
    }

    function _max3(uint256 x, uint256 y, uint256 z) private pure returns (uint256) {
        return _max(_max(x, y), z);
    }

    function max(uint256 x, uint256 y) external pure returns (uint256 z) {
        return _max(x, y);
    }

    function max3(uint256 x, uint256 y, uint256 z) external pure returns (uint256) {
        return _max3(x, y, z);
    }

    function applySafetyBuffer(uint256 rawLiability) external pure returns (uint256) {
        unchecked {
            return (rawLiability * SAFETY_BUFFER_BPS) / 10_000;
        }
    }
}
