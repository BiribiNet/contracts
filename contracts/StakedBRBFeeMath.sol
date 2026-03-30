// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Pure fee split from betting loss; keeps {StakedBRB} bytecode smaller.
library StakedBRBFeeMath {
    using Math for uint256;

    function feesFromLoss(
        uint256 lossAmount,
        uint256 jackpotBasisPoints,
        uint256 protocolFeeBasisPoints,
        uint256 burnBasisPoints,
        uint256 basisPointScale
    ) internal pure returns (uint256 protocolFees, uint256 burnAmount, uint256 jackpotAmount) {
        if (lossAmount == 0) return (0, 0, 0);

        jackpotAmount = lossAmount.mulDiv(jackpotBasisPoints, basisPointScale, Math.Rounding.Floor);
        protocolFees = lossAmount.mulDiv(protocolFeeBasisPoints, basisPointScale, Math.Rounding.Floor);
        burnAmount = lossAmount.mulDiv(burnBasisPoints, basisPointScale, Math.Rounding.Floor);
    }
}
