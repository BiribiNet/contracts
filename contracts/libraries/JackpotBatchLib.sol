// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { RouletteEngineStorageLib } from "./RouletteEngineStorageLib.sol";
import { IBankVault } from "../interfaces/IBankVault.sol";
import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";
interface IVaultAssetView { function asset() external view returns (address); }


/// @dev Linked library: keeps `RouletteEngine` deployed bytecode under EIP-170 without `viaIR`.
library JackpotBatchLib {
    event RoulettePayment(uint64 indexed roundId, uint32 indexed marketId, address indexed recipient, address token, uint256 amount);
    // The jackpot is global: no invented attribution to the trigger market.
    event JackpotPayment(uint64 indexed roundId, address indexed recipient, address indexed token, uint256 amount);
    struct RoundDiagnostics {
        uint256 requestId;
        uint256 requestedAt;
        bool available;
        bool fulfilled;
        uint8 winningNumber;
        uint8 jackpotNumber;
        uint32 marketsParticipating;
        uint32 marketsSettled;
        uint32 jackpotCursor;
        uint256 jackpotPaid;
        bool jackpotDistributed;
    }
    function diagnostics(uint64 roundId) external view returns (RoundDiagnostics memory d) {
        RouletteEngineStorageLib.Layout storage s = RouletteEngineStorageLib.layout();
        RouletteEngineStorageLib.GlobalRoundState storage r = s.globalRoundState[roundId];
        d.requestId = s.roundRequestId[roundId];
        d.requestedAt = s.roundRequestedAt[roundId];
        d.available = s.diagnosticsAvailable[roundId];
        d.fulfilled = r.vrfFulfilled;
        d.winningNumber = r.winningNumber;
        d.jackpotNumber = s.roundJackpotNumber[roundId];
        d.marketsParticipating = s._roundMarketParticipantCount[roundId];
        d.marketsSettled = s._roundMarketsSettledCount[roundId];
        d.jackpotCursor = r.jackpotCursor;
        d.jackpotPaid = r.jackpotPaid;
        d.jackpotDistributed = r.jackpotDistributed;
    }
    function payRoulette(IRouletteEngine.Job memory job, address bank, IBankVault.Payout[] memory rows) external returns (uint256 paid) {
        paid = IBankVault(bank).payoutBatch(rows);
        address token = IVaultAssetView(bank).asset();
        for (uint256 i; i < rows.length; ++i) {
            if (rows[i].amount != 0) emit RoulettePayment(job.roundId, job.marketId, rows[i].player, token, rows[i].amount);
        }
    }
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
