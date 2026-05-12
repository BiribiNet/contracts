// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Linked library: keeps `RouletteEngine` deployed bytecode under EIP-170 without `viaIR`.
library JackpotBatchLib {
    struct JackpotComputeArgs {
        address[] winners;
        uint256[] stakes;
        uint256 n;
        uint256 start;
        uint256 chunk;
        uint256 pool0;
        uint256 denom;
        uint256 paidBefore;
    }

    function computeBatch(JackpotComputeArgs memory a)
        external
        pure
        returns (address[] memory wChunk, uint256[] memory aChunk, uint256 paidInBatch, uint256 end)
    {
        wChunk = new address[](a.chunk);
        aChunk = new uint256[](a.chunk);
        end = a.start + a.chunk;

        uint256 idx;
        uint256 s;
        uint256 amt;
        for (uint256 i; i < a.chunk; ) {
            idx = a.start + i;
            s = a.stakes[idx];
            wChunk[i] = a.winners[idx];

            if (idx + 1 == a.n) amt = a.pool0 - (a.paidBefore + paidInBatch);
            else amt = (a.pool0 * s) / a.denom;

            aChunk[i] = amt;
            paidInBatch += amt;
            unchecked {
                ++i;
            }
        }
    }
}
