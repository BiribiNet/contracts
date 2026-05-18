// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { BetStorageLib } from "./BetStorageLib.sol";
import { IMarketRegistry } from "../interfaces/IMarketRegistry.sol";
import { IJackpotTreasury } from "../interfaces/IJackpotTreasury.sol";
import { IBRBJackpotFunder } from "../interfaces/IBRBJackpotFunder.sol";

/// @dev Shared ERC-7201 layout for `RouletteEngine` and linked libraries (bytecode offload without `viaIR`).
library RouletteEngineStorageLib {
    struct BetEntry {
        address player;
        uint128 amount;
        uint8 betType;
        uint16 number;
    }

    struct GlobalRoundState {
        bool vrfRequested;
        bool vrfFulfilled;
        uint256 randomWord;
        uint8 winningNumber;
        bool jackpotTriggered;
        bool jackpotDistributed;
        uint32 jackpotCursor;
        uint256 jackpotPaid;
        uint256 jackpotPoolSnapshot;
        uint256 jackpotTotalStake;
        uint32 jackpotWinnerCount;
    }

    struct MarketRoundState {
        bool betsReleased;
        uint256 winningBetCount;
        uint256 bankPaidRunning;
        bool settled;
        BetStorageLib.RoundTotals totals;
    }

    enum FlatBetBucket {
        Red,
        Black,
        Odd,
        Even,
        Low,
        High,
        Trio012,
        Trio023
    }

    enum NumberedBetBucket {
        Straight,
        Split,
        Street,
        Corner,
        Line,
        Column,
        Dozen
    }

    enum RoundPhase {
        Unset,
        Open,
        Locked,
        Settling,
        Completed
    }

    struct VrfLaneKeyHashes {
        bytes32 keyHash2Gwei;
        bytes32 keyHash30Gwei;
        bytes32 keyHash150Gwei;
    }

    struct InitConfig {
        address registry;
        address jackpotTreasury;
        address jackpotFunder;
        address infraRecipient;
        uint256 subscriptionId;
        VrfLaneKeyHashes vrfLaneKeyHashes;
        uint32 callbackGasLimit;
        uint16 confirmations;
        uint32 roundDuration;
        address admin;
        address upkeepScheduler;
    }

    /// @custom:storage-location erc7201:biribi.storage.RouletteEngine
    struct Layout {
        IMarketRegistry REGISTRY;
        IJackpotTreasury JACKPOT_TREASURY;
        IBRBJackpotFunder JACKPOT_FUNDER;
        uint256 VRF_SUBSCRIPTION_ID;
        bytes32 VRF_KEY_HASH_2_GWEI;
        bytes32 VRF_KEY_HASH_30_GWEI;
        bytes32 VRF_KEY_HASH_150_GWEI;
        uint32 VRF_CALLBACK_GAS_LIMIT;
        uint16 VRF_CONFIRMATIONS;
        uint32 ROUND_DURATION;
        uint64 _globalRound;
        uint256 _pendingRequestId;
        uint64 _activeVrfRound;
        uint64[] _vrfQueue;
        uint256 _vrfQueueHead;
        uint256 minJackpotBet;
        uint256 withdrawalQueueBatchSize;
        uint256 maxWithdrawalQueueLength;
        uint32 payoutLaneCount;
        address INFRA_RECIPIENT;
        address UPKEEP_SCHEDULER;
        mapping(uint64 => GlobalRoundState) globalRoundState;
        mapping(uint64 => mapping(uint32 => MarketRoundState)) marketRoundStateByRound;
        /// @dev Per-lane vault payout progress within a market round (`lane` = automation shard index).
        mapping(uint64 => mapping(uint32 => mapping(uint32 => uint256))) payoutCursorByShard;
        /// @dev Winning bet count assigned to each lane at VRF snapshot (`globalIndex % laneCount`).
        mapping(uint64 => mapping(uint32 => mapping(uint32 => uint256))) winningBetCountByShard;
        mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) roundStraightBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundMaxStraightBet;
        mapping(uint64 => mapping(uint32 => uint256)) roundMaxStreetBet;
        mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) roundStreetBetsTotal;
        mapping(uint64 => mapping(uint32 => uint256)) roundRedBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundBlackBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundOddBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundEvenBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundLowBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundHighBetsSum;
        mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) roundDozenBetsSum;
        mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) roundColumnBetsSum;
        mapping(uint64 => mapping(uint32 => uint256)) roundOtherBetsWeightedPayout;
        mapping(uint64 => mapping(uint32 => mapping(uint8 => mapping(uint256 => BetEntry[])))) roundNumberedBets;
        mapping(uint64 => mapping(uint32 => mapping(uint8 => BetEntry[]))) roundFlatBets;
        mapping(uint64 => uint32) _roundMarketParticipantCount;
        mapping(uint64 => uint32) _roundMarketsSettledCount;
        mapping(uint64 => mapping(uint32 => bool)) _roundHasMarket;
        mapping(uint64 => uint32) _roundTriggerMarket;
        mapping(uint64 => uint40) _roundLockAt;
        uint64 _payoutFinderRound;
        uint32 _payoutFinderMarket;
        /// @dev Phase of `_globalRound` only; older rounds are `Completed`, newer ids are `Unset` (see `phaseOfRound`).
        RoundPhase _roundPhase;
        mapping(uint256 => uint64) requestIdToGlobalRound;
    }

    // keccak256(abi.encode(uint256(keccak256("biribi.storage.RouletteEngine")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 internal constant STORAGE_LOCATION =
        0x8a653c570a28b92a786a8846d2fb5907e111615753e347ab6161fea696c7eb00;

    function layout() internal pure returns (Layout storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @dev Only one live round exists at a time; past/future ids are inferred without a per-round phase mapping.
    function phaseOfRound(Layout storage $, uint64 roundId) internal view returns (RoundPhase) {
        uint64 current = $._globalRound;
        if (roundId == 0 || roundId > current) return RoundPhase.Unset;
        if (roundId < current) return RoundPhase.Completed;
        return $._roundPhase;
    }
}
