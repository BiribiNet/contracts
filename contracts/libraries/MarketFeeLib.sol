// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";
import { IBRBJackpotFunder } from "../interfaces/IBRBJackpotFunder.sol";

/// @dev Shared protocol fee slice on house profit (`totalStakes - totalPaid`), matching `RouletteEngine._collectMarketFees`.
library MarketFeeLib {
    /// @notice Infrastructure fee on house profit (2% = 200 bps); remainder after swap slice stays with LPs.
    uint256 public constant INFRA_BPS = 200;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    struct CollectResult {
        uint256 swapIn;
        uint256 infraFee;
    }

    /// @notice Skips when `funder` is zero or `totalStakes <= totalPaid` (no house profit).
    /// @dev Transfers `swapIn` of market asset to `funder` then calls `fundFromMarket` (BRB markets skip swap in funder).
    function collect(
        IBRBJackpotFunder funder,
        address infraRecipient,
        address bank,
        uint32 marketId,
        uint256 totalStakes,
        uint256 totalPaid
    ) internal returns (CollectResult memory result) {
        if (address(funder) == address(0) || totalStakes <= totalPaid) {
            return result;
        }

        uint256 marketWin = totalStakes - totalPaid;
        uint256 swapBps = funder.swapAssetTotalBps();
        result.swapIn = (marketWin * swapBps) / BPS_DENOMINATOR;
        if (result.swapIn > 0) {
            address asset = IERC4626(bank).asset();
            IBankVault(bank).transferOut(address(funder), result.swapIn);
            funder.fundFromMarket(marketId, asset);
        }

        result.infraFee = (marketWin * INFRA_BPS) / BPS_DENOMINATOR;
        if (infraRecipient != address(0) && result.infraFee > 0) {
            IBankVault(bank).transferOut(infraRecipient, result.infraFee);
        }
    }
}
