// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "../interfaces/IBankVault.sol";
import { IRouletteEngine } from "../interfaces/IRouletteEngine.sol";

/// @dev Test engine exposing global-round outcomes for {SideBet} without full roulette / VRF.
contract MockRoundEngine {
    uint64 public currentGlobalRound = 1;

    mapping(uint64 => bool) public vrfFulfilled;
    mapping(uint64 => uint8) public winningNumber;
    mapping(uint64 => bool) public jackpotTriggered;

    address public jackpotFunder;
    address public infraRecipient;

    function recordBet(uint32, address, uint256, bytes calldata, address) external pure {}

    function registerMarketFromRegistry(uint32, address) external pure {}

    function isBankLiquidityRestricted(uint32) external pure returns (bool) {
        return false;
    }

    function maxWithdrawalQueueLength() external pure returns (uint256) {
        return 1000;
    }

    function withdrawalQueueBatchSize() external pure returns (uint256) {
        return 32;
    }

    function payoutParallelLaneCount() external pure returns (uint32) {
        return 1;
    }

    function findNextJob(uint32, uint32, uint32, uint32)
        external
        pure
        returns (bool found, IRouletteEngine.Job memory job)
    {
        return (false, job);
    }

    function payoutLaneHasWork(IRouletteEngine.Job memory) external pure returns (bool) {
        return false;
    }

    function previewPayoutBundle(IRouletteEngine.Job memory, uint32)
        external
        pure
        returns (IBankVault.Payout[] memory winnerPayoutRows, address[] memory jackpotWinners, uint256[] memory jackpotAmounts)
    {
        return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
    }

    function executeJob(
        IRouletteEngine.Job memory,
        IBankVault.Payout[] memory,
        address[] memory,
        uint256[] memory
    ) external pure returns (bool) {
        return false;
    }

    function hasPendingVrf() external pure returns (bool) {
        return false;
    }

    function vrfActiveRound() external pure returns (uint64) {
        return 0;
    }

    function JACKPOT_FUNDER() external view returns (address) {
        return jackpotFunder;
    }

    function INFRA_RECIPIENT() external view returns (address) {
        return infraRecipient;
    }

    function setFeeConfig(address funder, address infraRecipient_) external {
        jackpotFunder = funder;
        infraRecipient = infraRecipient_;
    }

    function roundOutcome(uint64 roundId) external view returns (bool fulfilled, uint8 number) {
        return (vrfFulfilled[roundId], winningNumber[roundId]);
    }

    function roundJackpotTriggered(uint64 roundId) external view returns (bool fulfilled, bool jackpot) {
        return (vrfFulfilled[roundId], jackpotTriggered[roundId]);
    }

    /// @dev Marks the current global round as VRF-fulfilled WITHOUT advancing the pointer,
    /// reproducing the real engine's window where `currentGlobalRound` is settling and its
    /// outcome is already public. Used to exercise the {SideBet} post-VRF placement guard.
    function markCurrentRoundFulfilled(uint8 number) external {
        uint64 rid = currentGlobalRound;
        vrfFulfilled[rid] = true;
        winningNumber[rid] = number;
    }

    /// @notice Records `number` for the current round and opens the next global round.
    function fulfillRound(uint8 number) external {
        fulfillRoundWithJackpot(number, false);
    }

    function fulfillRoundWithJackpot(uint8 number, bool jackpot) public {
        uint64 rid = currentGlobalRound;
        vrfFulfilled[rid] = true;
        winningNumber[rid] = number;
        jackpotTriggered[rid] = jackpot;
        unchecked {
            ++currentGlobalRound;
        }
    }

    function fulfillRounds(uint8[] calldata numbers) external {
        for (uint256 i; i < numbers.length; ) {
            fulfillRoundWithJackpot(numbers[i], false);
            unchecked {
                ++i;
            }
        }
    }

    function fulfillRoundsWithJackpot(uint8[] calldata numbers, bool[] calldata jackpots) public {
        if (numbers.length != jackpots.length) revert();
        for (uint256 i; i < numbers.length; ) {
            fulfillRoundWithJackpot(numbers[i], jackpots[i]);
            unchecked {
                ++i;
            }
        }
    }
}
