// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BRBJackpotFunder } from "../BRBJackpotFunder.sol";
import { UniswapV2TwapLib } from "../libraries/UniswapV2TwapLib.sol";

/// @dev Exposes internal TWAP / quote helpers for coverage without changing production bytecode paths.
contract BRBJackpotFunderHarness is BRBJackpotFunder {
    constructor(
        address engine_,
        address brb_,
        address router_,
        address jackpotTreasury_,
        address sideBet_,
        address admin
    ) BRBJackpotFunder(engine_, brb_, router_, jackpotTreasury_, sideBet_, admin) {}

    function harnessAmountOutMin(address asset, uint256 swapIn) external view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = asset;
        path[1] = address(brb);
        return _amountOutMin(asset, swapIn, path);
    }

    function harnessSetPairObservation(
        address pair,
        uint32 timestamp,
        uint256 price0Cumulative,
        uint256 price1Cumulative
    ) external {
        pairObservations[pair] = UniswapV2TwapLib.Observation({
            timestamp: timestamp,
            price0Cumulative: price0Cumulative,
            price1Cumulative: price1Cumulative
        });
    }

    function harnessSnapshotPairObservation(address asset) external {
        _snapshotPairObservation(asset);
    }

    function harnessPairFor(address asset) external view returns (address) {
        return _assetBrbPair(asset);
    }

    function harnessQuoteOut(address asset, uint256 swapIn) external view returns (uint256 quotedOut, bool usedTwap) {
        address pair = _assetBrbPair(asset);
        return _quoteOut(pair, asset, swapIn);
    }
}
