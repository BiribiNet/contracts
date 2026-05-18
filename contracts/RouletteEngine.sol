// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { VRFCoordinatorV2Interface } from "@chainlink/contracts/src/v0.8/vrf/interfaces/VRFCoordinatorV2Interface.sol";
import { VRFConsumerBaseV2 } from "./external/VRFConsumerBaseV2.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IRouletteBetErrors } from "./interfaces/IRouletteBetErrors.sol";
import { BetStorageLib } from "./libraries/BetStorageLib.sol";
import { RouletteBetCodecLib } from "./libraries/RouletteBetCodecLib.sol";
import { JackpotBatchLib } from "./libraries/JackpotBatchLib.sol";
import { RouletteLiabilityMathLib } from "./libraries/RouletteLiabilityMathLib.sol";
import { RouletteEngineStorageLib } from "./libraries/RouletteEngineStorageLib.sol";
import { RouletteExposureLib } from "./libraries/RouletteExposureLib.sol";
import { RoulettePayoutSweepLib } from "./libraries/RoulettePayoutSweepLib.sol";
import { RouletteJackpotCollectLib } from "./libraries/RouletteJackpotCollectLib.sol";
import { RouletteUpkeepScanLib } from "./libraries/RouletteUpkeepScanLib.sol";

/// @notice UUPS proxy implementation. Deploy implementation with `vrfCoordinator`, then `ERC1967Proxy` + `initialize`.
contract RouletteEngine is Initializable, OwnableUpgradeable, UUPSUpgradeable, VRFConsumerBaseV2, IRouletteEngine {
    using BetStorageLib for BetStorageLib.RoundTotals;

    /// @dev Legacy role id bytes (off-chain / tooling); access is `onlyOwner` / `UPKEEP_SCHEDULER`.
    bytes32 public constant ENGINE_ADMIN_ROLE = keccak256("ENGINE_ADMIN_ROLE");
    bytes32 public constant SCHEDULER_ROLE = keccak256("SCHEDULER_ROLE");

    uint8 private constant BET_STRAIGHT = 1;
    uint8 private constant BET_SPLIT = 2;
    uint8 private constant BET_STREET = 3;
    uint8 private constant BET_CORNER = 4;
    uint8 private constant BET_LINE = 5;
    uint8 private constant BET_COLUMN = 6;
    uint8 private constant BET_DOZEN = 7;
    uint8 private constant BET_RED = 8;
    uint8 private constant BET_BLACK = 9;
    uint8 private constant BET_ODD = 10;
    uint8 private constant BET_EVEN = 11;
    uint8 private constant BET_LOW = 12;
    uint8 private constant BET_HIGH = 13;
    uint8 private constant BET_TRIO_012 = 14;
    uint8 private constant BET_TRIO_023 = 15;
    uint256 private constant INFRA_BPS = 250;

    uint32 public constant DEFAULT_PAYOUT_LANE_COUNT = 10;

    function _s() private pure returns (RouletteEngineStorageLib.Layout storage $) {
        return RouletteEngineStorageLib.layout();
    }

    // --- Public getters (ABI-compatible with prior public state vars) ---
    function REGISTRY() external view returns (IMarketRegistry) {
        return _s().REGISTRY;
    }

    function JACKPOT_TREASURY() external view returns (IJackpotTreasury) {
        return _s().JACKPOT_TREASURY;
    }

    function JACKPOT_FUNDER() external view returns (IBRBJackpotFunder) {
        return _s().JACKPOT_FUNDER;
    }

    function VRF_SUBSCRIPTION_ID() external view returns (uint256) {
        return _s().VRF_SUBSCRIPTION_ID;
    }

    function VRF_KEY_HASH_2_GWEI() external view returns (bytes32) {
        return _s().VRF_KEY_HASH_2_GWEI;
    }

    function VRF_KEY_HASH_30_GWEI() external view returns (bytes32) {
        return _s().VRF_KEY_HASH_30_GWEI;
    }

    function VRF_KEY_HASH_150_GWEI() external view returns (bytes32) {
        return _s().VRF_KEY_HASH_150_GWEI;
    }

    function VRF_CALLBACK_GAS_LIMIT() external view returns (uint32) {
        return _s().VRF_CALLBACK_GAS_LIMIT;
    }

    function VRF_CONFIRMATIONS() external view returns (uint16) {
        return _s().VRF_CONFIRMATIONS;
    }

    function ROUND_DURATION() external view returns (uint32) {
        return _s().ROUND_DURATION;
    }

    function minJackpotBet() external view returns (uint256) {
        return _s().minJackpotBet;
    }

    function withdrawalQueueBatchSize() external view returns (uint256) {
        return _s().withdrawalQueueBatchSize;
    }

    function maxWithdrawalQueueLength() external view returns (uint256) {
        return _s().maxWithdrawalQueueLength;
    }

    function INFRA_RECIPIENT() external view returns (address) {
        return _s().INFRA_RECIPIENT;
    }

    function UPKEEP_SCHEDULER() external view returns (address) {
        return _s().UPKEEP_SCHEDULER;
    }

    function globalRoundState(uint64 roundId)
        external
        view
        returns (RouletteEngineStorageLib.GlobalRoundState memory)
    {
        return _s().globalRoundState[roundId];
    }

    function marketRoundStateByRound(uint64 roundId, uint32 marketId)
        external
        view
        returns (RouletteEngineStorageLib.MarketRoundState memory)
    {
        return _s().marketRoundStateByRound[roundId][marketId];
    }

    function roundStraightBetsSum(uint64 roundId, uint32 marketId, uint256 number)
        external
        view
        returns (uint256)
    {
        return _s().roundStraightBetsSum[roundId][marketId][number];
    }

    function roundPhase(uint64 roundId) external view returns (RouletteEngineStorageLib.RoundPhase) {
        return RouletteEngineStorageLib.phaseOfRound(_s(), roundId);
    }

    function requestIdToGlobalRound(uint256 requestId) external view returns (uint64) {
        return _s().requestIdToGlobalRound[requestId];
    }

    uint256 public constant DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE = 5;
    uint256 public constant MAX_WITHDRAWAL_QUEUE_BATCH_SIZE = 20;
    uint256 public constant DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH = 100;
    uint256 public constant MAX_MAX_WITHDRAWAL_QUEUE_LENGTH = 1000;


    error UnauthorizedScheduler();
    error UnauthorizedBank();
    error RoundIsLocked();
    error BettingClosedAwaitingSeal();
    error NoBets();
    error NoOpenRound();
    error VrfAlreadyPending();
    error InvalidJob();
    error InvalidRound();
    error ZeroAddress();
    error InvalidRoundDuration();
    error InvalidWithdrawalQueueBatchSize();
    error InvalidMaxWithdrawalQueueLength();
    error OnlyRegistry();
    error InsufficientBankForMaxPayout();

    event MarketRegistered(uint32 marketId, address bank);

    event VrfRequested(uint64 newRoundId, uint256 requestId, uint256 timestamp);
    event VRFResult(uint64 roundId, uint8 winningNumber, uint8 jackpotNumber);
    event RoundResolved(uint64 roundId);

    event MinJackpotConditionUpdated(uint256 newMinJackpotCondition);

    event BetRecorded(
        uint32 marketId,
        uint64 localRound,
        address player,
        uint256 amount,
        uint8 betType,
        uint16 number
    );
    event RoundLocked(uint32 marketId, uint64 roundId, uint64 globalRoundId);
    event GlobalRoundSealed(uint64 globalRoundId, uint32 triggerMarketId);
    event PayoutProgress(uint64 globalRoundId, uint32 marketId, uint256 fromCursor, uint256 toCursor, uint256 paidAmount);
    event JackpotFunded(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event InfrastructureFeePaid(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event WithdrawalQueueBatchSizeUpdated(uint256 newBatchSize);
    event MaxWithdrawalQueueLengthUpdated(uint256 newMaxLength);

    modifier onlyScheduler() {
        if (msg.sender != _s().UPKEEP_SCHEDULER) revert UnauthorizedScheduler();
        _;
    }

    modifier onlyBank(uint32 marketId) {
        IMarketRegistry.MarketConfig memory cfg = _s().REGISTRY.getMarket(marketId);
        if (cfg.bank != msg.sender) revert UnauthorizedBank();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != address(_s().REGISTRY)) revert OnlyRegistry();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address vrfCoordinator) VRFConsumerBaseV2(vrfCoordinator) {
        _disableInitializers();
    }

    /// @dev Opens global round `1` in `Open` phase; further rounds open automatically when the previous round completes.
    function initialize(RouletteEngineStorageLib.InitConfig calldata cfg) external initializer {
        if (
            cfg.registry == address(0) || cfg.jackpotTreasury == address(0) || cfg.jackpotFunder == address(0)
                || cfg.infraRecipient == address(0) || cfg.admin == address(0) || cfg.upkeepScheduler == address(0)
        ) revert ZeroAddress();
        if (cfg.roundDuration == 0) revert InvalidRoundDuration();

        __Ownable_init(cfg.admin);

        RouletteEngineStorageLib.Layout storage $ = _s();
        $.REGISTRY = IMarketRegistry(cfg.registry);
        $.JACKPOT_TREASURY = IJackpotTreasury(cfg.jackpotTreasury);
        $.JACKPOT_FUNDER = IBRBJackpotFunder(cfg.jackpotFunder);
        $.INFRA_RECIPIENT = cfg.infraRecipient;
        $.UPKEEP_SCHEDULER = cfg.upkeepScheduler;
        $.VRF_SUBSCRIPTION_ID = cfg.subscriptionId;
        $.VRF_KEY_HASH_2_GWEI = cfg.vrfLaneKeyHashes.keyHash2Gwei;
        $.VRF_KEY_HASH_30_GWEI = cfg.vrfLaneKeyHashes.keyHash30Gwei;
        $.VRF_KEY_HASH_150_GWEI = cfg.vrfLaneKeyHashes.keyHash150Gwei;
        $.VRF_CALLBACK_GAS_LIMIT = cfg.callbackGasLimit;
        $.VRF_CONFIRMATIONS = cfg.confirmations;
        $.ROUND_DURATION = cfg.roundDuration;
        $.withdrawalQueueBatchSize = DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE;
        $.maxWithdrawalQueueLength = DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH;
        $.payoutLaneCount = DEFAULT_PAYOUT_LANE_COUNT;
        $._globalRound = 1;
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Open;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @inheritdoc IRouletteEngine
    function isBankLiquidityRestricted(uint32 marketId) public view returns (bool) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 r = $._globalRound;
        if (!$._roundHasMarket[r][marketId]) return false;
        RouletteEngineStorageLib.RoundPhase ph = $._roundPhase;
        if (ph != RouletteEngineStorageLib.RoundPhase.Locked && ph != RouletteEngineStorageLib.RoundPhase.Settling) return false;
        return !$.marketRoundStateByRound[r][marketId].settled;
    }

    function setWithdrawalQueueBatchSize(uint256 newBatchSize) external onlyOwner {
        if (newBatchSize == 0 || newBatchSize > MAX_WITHDRAWAL_QUEUE_BATCH_SIZE) revert InvalidWithdrawalQueueBatchSize();
        _s().withdrawalQueueBatchSize = newBatchSize;
        emit WithdrawalQueueBatchSizeUpdated(newBatchSize);
    }

    function setMaxWithdrawalQueueLength(uint256 newMaxLength) external onlyOwner {
        if (newMaxLength == 0 || newMaxLength > MAX_MAX_WITHDRAWAL_QUEUE_LENGTH) revert InvalidMaxWithdrawalQueueLength();
        _s().maxWithdrawalQueueLength = newMaxLength;
        emit MaxWithdrawalQueueLengthUpdated(newMaxLength);
    }

    function setPayoutLaneCount(uint32 newLaneCount) external onlyOwner {
        if (newLaneCount == 0) revert InvalidJob();
        _s().payoutLaneCount = newLaneCount;
    }

    /// @inheritdoc IRouletteEngine
    function payoutParallelLaneCount() external view returns (uint32) {
        uint32 n = _s().payoutLaneCount;
        return n == 0 ? 1 : n;
    }

    function setMinJackpotBet(uint256 newMinJackpotBet) external onlyOwner {
        _s().minJackpotBet = newMinJackpotBet;
        emit MinJackpotConditionUpdated(newMinJackpotBet);
    }

    function registerMarketFromRegistry(uint32 marketId, address bank) external onlyRegistry {
        _registerMarket(marketId, bank);
    }

    function _registerMarket(uint32 marketId, address bank) private {
        IMarketRegistry.MarketConfig memory cfg = _s().REGISTRY.getMarket(marketId);
        if (bank != cfg.bank) revert InvalidRound();
        emit MarketRegistered(marketId, bank);
    }

    function recordBet(uint32 marketId, address player, uint256 amount, bytes calldata betData) external onlyBank(marketId) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = _resolveOpenRound($, marketId);
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) revert RoundIsLocked();
        if (_preLockUpkeepCandidate($, roundId)) revert BettingClosedAwaitingSeal();
        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        if ($._roundTriggerMarket[roundId] == 0) {
            $._roundTriggerMarket[roundId] = marketId;
            $._roundLockAt[roundId] = uint40(block.timestamp + uint256($.ROUND_DURATION));
        }

        uint256 runningSum = _recordMultiBetPayload($, roundId, marketId, player, betData);
        if (runningSum != amount) revert IRouletteBetErrors.InvalidBetNumber();
        mr.totals.addBet(amount);

        // Bets are recorded before the vault pulls tokens; solvency is checked against balance after this transfer.
        IMarketRegistry.MarketConfig memory cfg = $.REGISTRY.getMarket(marketId);
        uint256 bankBal = IERC20(cfg.asset).balanceOf(cfg.bank);
        if (bankBal + amount < _bufferedMarketMaxLiability($, roundId, marketId)) {
            revert InsufficientBankForMaxPayout();
        }
    }

    function _recordMultiBetPayload(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address player,
        bytes calldata betData
    ) private returns (uint256 runningSum) {
        (uint256[] memory betTypes, uint256[] memory numbers, uint256[] memory amounts) =
            abi.decode(betData, (uint256[], uint256[], uint256[]));
        uint256 len = betTypes.length;
        if (len == 0 || numbers.length != len || amounts.length != len) revert IRouletteBetErrors.InvalidBetType();

        for (uint256 i; i < len; ) {
            uint256 a = amounts[i];
            runningSum += a;
            _recordAndEmitBet($, roundId, marketId, player, a, betTypes[i], numbers[i]);
            unchecked { ++i; }
        }
    }

    function _recordAndEmitBet(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address player,
        uint256 amount,
        uint256 betTypeRaw,
        uint256 numberRaw
    ) private {
        if (betTypeRaw == 0 || betTypeRaw > BET_TRIO_023) revert IRouletteBetErrors.InvalidBetType();
        RouletteBetCodecLib.validateBetNumber(betTypeRaw, numberRaw);
        uint8 betType = uint8(betTypeRaw);
        uint16 number = uint16(numberRaw);
        RouletteEngineStorageLib.BetEntry memory bet =
            RouletteEngineStorageLib.BetEntry(player, uint128(amount), betType, number);
        _recordBetEntry($, roundId, marketId, bet);
        RouletteExposureLib.accumulate($, roundId, marketId, bet.betType, bet.number, bet.amount);
        emit BetRecorded(marketId, roundId, player, amount, betType, number);
    }

    function _recordBetEntry(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        RouletteEngineStorageLib.BetEntry memory bet
    ) private {
        (bool isNumbered, uint8 bucket) = RouletteBetCodecLib.routeBet(bet.betType);
        if (isNumbered) {
            $.roundNumberedBets[roundId][marketId][bucket][bet.number].push(bet);
            if (bet.betType == BET_STRAIGHT) {
                $.roundStraightBetsSum[roundId][marketId][bet.number] += uint256(bet.amount);
            }
        } else {
            $.roundFlatBets[roundId][marketId][bucket].push(bet);
        }
    }

    function findNextJob(uint32 startCursor, uint32 scanLimit) external view returns (bool found, Job memory job) {
        return _findNextJob(startCursor, scanLimit, 0);
    }

    /// @inheritdoc IRouletteEngine
    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit,
        uint32 payoutLane,
        uint32 payoutShardWidth
    ) external view returns (bool found, Job memory job) {
        if (payoutShardWidth != 0) return (false, job);
        return _findNextJob(startCursor, scanLimit, payoutLane);
    }

    /// @notice Global payout scan; all lanes may service the same market (vault winners sharded by lane index).
    function _findNextJob(uint32 startCursor, uint32, uint32 payoutLane) private view returns (bool found, Job memory job) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint32 totalMarkets = $.REGISTRY.marketCount();
        if (totalMarkets == 0) return (false, job);

        uint32 laneCount = $.payoutLaneCount;
        if (laneCount == 0) laneCount = 1;
        if (payoutLane >= laneCount) return (false, job);

        (uint64 payoutRound, uint32 payoutMarket) = RouletteUpkeepScanLib.findFirstPayout($, totalMarkets);
        if (payoutRound != 0) {
            return (true, _payoutJob(payoutRound, payoutMarket, startCursor, payoutLane, laneCount));
        }

        if (payoutLane != 0) return (false, job);

        if ($._pendingRequestId == 0 && $._vrfQueueHead < $._vrfQueue.length) {
            return (true, Job({
                kind: JobKind.TriggerVrf,
                marketId: 0,
                roundId: $._vrfQueue[$._vrfQueueHead],
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }

        uint64 roundId = $._globalRound;
        if (_preLockUpkeepCandidate($, roundId)) {
            return (true, Job({
                kind: JobKind.PreLock,
                marketId: 0,
                roundId: roundId,
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }
        return (false, job);
    }

    /// @dev Same predicate as `JobKind.PreLock` in `findNextJob`: once true, `recordBet` is blocked until `_sealGlobalRound`.
    function _preLockUpkeepCandidate(RouletteEngineStorageLib.Layout storage $, uint64 roundId) private view returns (bool) {
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) return false;
        uint32 triggerMarketId = $._roundTriggerMarket[roundId];
        if (triggerMarketId == 0) return false;
        uint40 lockAt = $._roundLockAt[roundId];
        if (lockAt == 0 || block.timestamp < uint256(lockAt)) return false;
        return $.marketRoundStateByRound[roundId][triggerMarketId].totals.betCount > 0;
    }

    /// @dev Dedicated stack frame for `JobKind.Payout` literals (non-IR solc stack limits).
    function _payoutJob(
        uint64 roundId_,
        uint32 marketId_,
        uint32 nextCursor_,
        uint32 payoutShardIndex_,
        uint32 payoutShardWidth_
    ) private pure returns (Job memory j) {
        j = Job({
            kind: JobKind.Payout,
            marketId: marketId_,
            roundId: roundId_,
            nextCursor: nextCursor_,
            payoutShardIndex: payoutShardIndex_,
            payoutShardWidth: payoutShardWidth_
        });
    }

    /// @inheritdoc IRouletteEngine
    function previewPayoutBundle(Job memory job, uint32 maxPayoutsPerCall)
        external
        view
        returns (
            IBankVault.Payout[] memory winnerPayoutRows,
            address[] memory jackpotWinners,
            uint256[] memory jackpotAmounts
        )
    {
        if (job.kind != JobKind.Payout || maxPayoutsPerCall == 0 || job.payoutShardWidth == 0) {
            return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
        }
        return _previewPayoutBundleShard(
            job.roundId, job.marketId, job.payoutShardIndex, job.payoutShardWidth, maxPayoutsPerCall
        );
    }

    function _previewPayoutBundleShard(
        uint64 roundId,
        uint32 marketId,
        uint32 lane,
        uint32 laneCount,
        uint32 maxPayoutsPerCall
    ) private view returns (
        IBankVault.Payout[] memory winnerPayoutRows,
        address[] memory jackpotWinners,
        uint256[] memory jackpotAmounts
    ) {
        if (lane >= laneCount) return (winnerPayoutRows, jackpotWinners, jackpotAmounts);

        RouletteEngineStorageLib.Layout storage $ = _s();
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        if (!gr.vrfFulfilled) return (winnerPayoutRows, jackpotWinners, jackpotAmounts);

        if ($.marketRoundStateByRound[roundId][marketId].settled) {
            return (winnerPayoutRows, jackpotWinners, jackpotAmounts);
        }

        if (lane == 0 && gr.jackpotTriggered && !gr.jackpotDistributed && marketId == $._roundTriggerMarket[roundId]) {
            (jackpotWinners, jackpotAmounts) = _previewJackpotPayouts($, roundId, gr.winningNumber, maxPayoutsPerCall);
        }

        winnerPayoutRows = _previewVaultShardPayouts($, roundId, marketId, gr.winningNumber, lane, laneCount, maxPayoutsPerCall);
    }

    /// @inheritdoc IRouletteEngine
    function payoutLaneHasWork(Job memory job) external view returns (bool) {
        if (job.kind != JobKind.Payout || job.payoutShardWidth == 0) return false;
        uint32 lane = job.payoutShardIndex;
        uint32 laneCount = job.payoutShardWidth;
        if (lane >= laneCount) return false;

        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = job.roundId;
        uint32 marketId = job.marketId;
        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        if (mr.settled) return false;

        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        if (!gr.vrfFulfilled) return false;

        if ($.payoutCursorByShard[roundId][marketId][lane] < $.winningBetCountByShard[roundId][marketId][lane]) {
            return true;
        }

        if (lane == 0 && gr.jackpotTriggered && !gr.jackpotDistributed && marketId == $._roundTriggerMarket[roundId]) {
            (address[] memory winners,, uint256 totalStake) =
                RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, gr.winningNumber, $.minJackpotBet);
            if (totalStake > 0 && uint256(gr.jackpotCursor) < winners.length) return true;
        }

        return lane == 0 && mr.winningBetCount == 0 && _allPayoutShardsComplete($, roundId, marketId, laneCount);
    }

    function _previewVaultShardPayouts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint32 lane,
        uint32 laneCount,
        uint32 maxPayoutsPerCall
    ) private view returns (IBankVault.Payout[] memory rows) {
        uint256 shardTotal = $.winningBetCountByShard[roundId][marketId][lane];
        if (shardTotal == 0) return rows;

        uint256 start = $.payoutCursorByShard[roundId][marketId][lane];
        if (start >= shardTotal) return rows;

        uint256 chunk = shardTotal - start > uint256(maxPayoutsPerCall)
            ? uint256(maxPayoutsPerCall)
            : shardTotal - start;

        (rows,,,) = RoulettePayoutSweepLib.previewWinningPayoutsSlice(
            $, roundId, marketId, winningNumber, start, chunk, chunk, lane, laneCount
        );
    }

    function executeJob(
        Job memory job,
        uint32 maxPayoutsPerCall,
        IBankVault.Payout[] memory winnerPayoutRows,
        address[] memory jackpotWinners,
        uint256[] memory jackpotAmounts
    ) external onlyScheduler returns (bool) {
        if (job.kind == JobKind.PreLock) {
            _sealGlobalRound();
            return true;
        }
        if (job.kind == JobKind.TriggerVrf) {
            _triggerVrf();
            return true;
        }
        if (job.kind == JobKind.Payout) {
            _applyPreparedPayout(job, winnerPayoutRows, jackpotWinners, jackpotAmounts);
            return true;
        }
        revert InvalidJob();
    }

    function currentGlobalRound() external view returns (uint64) { return _s()._globalRound; }
    function hasPendingVrf() external view returns (bool) { return _s()._pendingRequestId != 0; }
    function vrfActiveRound() external view returns (uint64) { return _s()._activeVrfRound; }
    function vrfActiveMarket() external pure returns (uint32) { return 0; }

    function _resolveOpenRound(RouletteEngineStorageLib.Layout storage $, uint32 marketId) private returns (uint64 roundId) {
        roundId = $._globalRound;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) revert NoOpenRound();
        if (!$._roundHasMarket[roundId][marketId]) {
            $._roundHasMarket[roundId][marketId] = true;
            unchecked {
                ++$._roundMarketParticipantCount[roundId];
            }
        }
    }

    function _openNextRound() private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        unchecked {
            ++$._globalRound;
        }
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Open;
    }

    // Pre-VRF lock step: freezes the current global round.
    function _sealGlobalRound() private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = $._globalRound;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) revert InvalidRound();
        uint32 triggerMarketId = $._roundTriggerMarket[roundId];
        if (triggerMarketId == 0) revert InvalidRound();
        if (block.timestamp < uint256($._roundLockAt[roundId])) revert InvalidRound();
        if ($.marketRoundStateByRound[roundId][triggerMarketId].totals.betCount == 0) revert NoBets();

        emit RoundLocked(triggerMarketId, roundId, roundId);
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Locked;
        emit GlobalRoundSealed(roundId, triggerMarketId);
        $._vrfQueue.push(roundId);
    }

    function _triggerVrf() private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        if ($._pendingRequestId != 0) revert VrfAlreadyPending();
        if ($._vrfQueueHead >= $._vrfQueue.length) revert InvalidRound();

        uint64 roundId = $._vrfQueue[$._vrfQueueHead];
        if (roundId != $._globalRound) revert InvalidRound();
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Locked) revert InvalidRound();
        $.globalRoundState[roundId].vrfRequested = true;
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Settling;
        $._activeVrfRound = roundId;

        bytes32 keyHash = tx.gasprice < 2 gwei
            ? $.VRF_KEY_HASH_2_GWEI
            : tx.gasprice < 30 gwei ? $.VRF_KEY_HASH_30_GWEI : $.VRF_KEY_HASH_150_GWEI;
        uint256 req = VRFCoordinatorV2Interface(address(vrfCoordinator())).requestRandomWords(
            keyHash,
            uint64($.VRF_SUBSCRIPTION_ID),
            $.VRF_CONFIRMATIONS,
            $.VRF_CALLBACK_GAS_LIMIT,
            2
        );
        $._pendingRequestId = req;
        $.requestIdToGlobalRound[req] = roundId;
        emit VrfRequested(roundId, req, block.timestamp);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = $.requestIdToGlobalRound[requestId];
        if (roundId == 0) revert InvalidRound();

        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        gr.vrfFulfilled = true;
        gr.randomWord = randomWords[0];
        uint256 modWin = randomWords[0] % 37;
        uint8 winningNumber = uint8(modWin);
        gr.winningNumber = winningNumber;
        RoulettePayoutSweepLib.snapshotRoundMarketWinningCounts($, roundId, winningNumber);

        uint8 jackpotNumber = uint8(randomWords[1] % 37);
        if (winningNumber == jackpotNumber) {
            gr.jackpotTriggered = true;
        }

        $._pendingRequestId = 0;
        $._activeVrfRound = 0;
        $._vrfQueueHead += 1;

        emit VRFResult(roundId, winningNumber, jackpotNumber);

        if ($._payoutFinderRound == 0 || roundId < $._payoutFinderRound) {
            $._payoutFinderRound = roundId;
            $._payoutFinderMarket = 1;
        }
    }

    /// @dev Applies the bundle built in `previewPayoutBundle` during `checkUpkeep`. Trusted scheduler + Automation only.
    function _applyPreparedPayout(
        Job memory job,
        IBankVault.Payout[] memory winnerPayoutRows,
        address[] memory jackpotWinners,
        uint256[] memory jackpotAmounts
    ) private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = job.roundId;
        uint32 marketId = job.marketId;
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        address bank = $.REGISTRY.getMarket(marketId).bank;

        if (!mr.betsReleased) {
            IBankVault(bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }

        uint32 lane = job.payoutShardIndex;
        uint32 laneCount = job.payoutShardWidth;

        if (lane == 0 && jackpotWinners.length != 0) {
            _applyJackpotChunkPrepared($, roundId, gr.winningNumber, gr, jackpotWinners, jackpotAmounts);
        }

        uint256 n = winnerPayoutRows.length;
        if (n == 0) {
            if (mr.winningBetCount == 0 && _allPayoutShardsComplete($, roundId, marketId, laneCount)) {
                _finalizeMarketSettlement($, roundId, marketId, bank, mr, 0, 0);
            }
            return;
        }

        uint256 start = $.payoutCursorByShard[roundId][marketId][lane];
        uint256 bankPaid = IBankVault(bank).payoutBatch(winnerPayoutRows);
        uint256 end = start + n;
        $.payoutCursorByShard[roundId][marketId][lane] = end;
        mr.bankPaidRunning += bankPaid;
        emit PayoutProgress(roundId, marketId, start, end, bankPaid);

        if (end >= $.winningBetCountByShard[roundId][marketId][lane] && _allPayoutShardsComplete($, roundId, marketId, laneCount)) {
            _finalizeMarketSettlement($, roundId, marketId, bank, mr, uint32(start), bankPaid);
        }
    }

    function _allPayoutShardsComplete(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        uint32 laneCount
    ) private view returns (bool) {
        for (uint32 lane; lane < laneCount; ) {
            if ($.payoutCursorByShard[roundId][marketId][lane] < $.winningBetCountByShard[roundId][marketId][lane]) {
                return false;
            }
            unchecked {
                ++lane;
            }
        }
        return true;
    }

    function _finalizeMarketSettlement(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address bank,
        RouletteEngineStorageLib.MarketRoundState storage mr,
        uint32,
        uint256
    ) private {
        if (mr.settled) return;
        _collectMarketFees($, roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
        mr.settled = true;
        unchecked {
            ++$._roundMarketsSettledCount[roundId];
        }
        IBankVault(bank).processWithdrawalQueue($.withdrawalQueueBatchSize);
        RouletteUpkeepScanLib.advancePayoutFinderHintAfterSettlement($, roundId, marketId, $.REGISTRY.marketCount());
        _tryCompleteGlobalRound($, roundId);
    }

    function _tryCompleteGlobalRound(RouletteEngineStorageLib.Layout storage $, uint64 rid) private {
        if (!_isRoundDone($, rid)) return;
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Completed;
        emit RoundResolved(rid);
        _openNextRound();
    }

    function _collectMarketFees(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address bank,
        uint256 totalBets,
        uint256 bankPaid
    ) private {
        if (totalBets <= bankPaid) return;
        uint256 marketWin = totalBets - bankPaid;
        uint256 swapBps = $.JACKPOT_FUNDER.swapAssetTotalBps();
        uint256 swapIn = (marketWin * swapBps) / 10_000;
        if (swapIn > 0) {
            address asset = IERC4626(bank).asset();
            IBankVault(bank).transferOut(address($.JACKPOT_FUNDER), swapIn);
            $.JACKPOT_FUNDER.fundFromMarket(marketId, asset);
            emit JackpotFunded(roundId, marketId, swapIn);
        }
        uint256 infraFee = (marketWin * INFRA_BPS) / 10_000;
        if (infraFee > 0) {
            IBankVault(bank).transferOut($.INFRA_RECIPIENT, infraFee);
            emit InfrastructureFeePaid(roundId, marketId, infraFee);
        }
    }

    function _previewJackpotPayouts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber,
        uint32 maxPayoutsPerCall
    ) private view returns (address[] memory jackpotWinners, uint256[] memory jackpotAmounts) {
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        (address[] memory winners, uint256[] memory stakes, uint256 totalStake) =
            RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, winningNumber, $.minJackpotBet);
        uint256 n = winners.length;
        if (totalStake == 0 || n == 0) return (jackpotWinners, jackpotAmounts);

        uint256 pool0 = gr.jackpotPoolSnapshot;
        if (pool0 == 0) pool0 = $.JACKPOT_TREASURY.jackpotPool();
        uint256 denom = gr.jackpotTotalStake;
        if (denom == 0) denom = totalStake;

        uint256 start = uint256(gr.jackpotCursor);
        if (start >= n) return (jackpotWinners, jackpotAmounts);

        uint256 chunk = n - start > uint256(maxPayoutsPerCall) ? uint256(maxPayoutsPerCall) : n - start;
        JackpotBatchLib.JackpotComputeArgs memory args = JackpotBatchLib.JackpotComputeArgs({
            winners: winners,
            stakes: stakes,
            n: n,
            start: start,
            chunk: chunk,
            pool0: pool0,
            denom: denom,
            paidBefore: gr.jackpotPaid
        });
        (jackpotWinners, jackpotAmounts,,) = JackpotBatchLib.computeBatch(args);
    }

    /// @dev Pays the jackpot chunk from `previewPayoutBundle`; snapshots pool/stake counts on the first chunk only.
    function _applyJackpotChunkPrepared(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber,
        RouletteEngineStorageLib.GlobalRoundState storage gr,
        address[] memory winners,
        uint256[] memory amounts
    ) private {
        if (gr.jackpotPoolSnapshot == 0) {
            (address[] memory allWinners,, uint256 totalStake) =
                RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, winningNumber, $.minJackpotBet);
            gr.jackpotPoolSnapshot = $.JACKPOT_TREASURY.jackpotPool();
            gr.jackpotTotalStake = totalStake;
            gr.jackpotWinnerCount = uint32(allWinners.length);
        }

        uint256 paid = $.JACKPOT_TREASURY.payBatch(winners, amounts);
        gr.jackpotPaid += paid;
        gr.jackpotCursor += uint32(winners.length);
        if (gr.jackpotCursor >= gr.jackpotWinnerCount) gr.jackpotDistributed = true;
    }

    function _isRoundDone(RouletteEngineStorageLib.Layout storage $, uint64 roundId) private view returns (bool) {
        uint32 n = $._roundMarketParticipantCount[roundId];
        if (n == 0) return false;
        return $._roundMarketsSettledCount[roundId] == n;
    }

    function _bufferedMarketMaxLiability(RouletteEngineStorageLib.Layout storage $, uint64 rid, uint32 mid)
        private
        view
        returns (uint256)
    {
        RouletteLiabilityMathLib.Inputs memory liab;
        liab.maxStraightBet = $.roundMaxStraightBet[rid][mid];
        liab.maxStreetBet = $.roundMaxStreetBet[rid][mid];
        liab.redSum = $.roundRedBetsSum[rid][mid];
        liab.blackSum = $.roundBlackBetsSum[rid][mid];
        liab.oddSum = $.roundOddBetsSum[rid][mid];
        liab.evenSum = $.roundEvenBetsSum[rid][mid];
        liab.lowSum = $.roundLowBetsSum[rid][mid];
        liab.highSum = $.roundHighBetsSum[rid][mid];
        liab.dozen1 = $.roundDozenBetsSum[rid][mid][1];
        liab.dozen2 = $.roundDozenBetsSum[rid][mid][2];
        liab.dozen3 = $.roundDozenBetsSum[rid][mid][3];
        liab.col1 = $.roundColumnBetsSum[rid][mid][1];
        liab.col2 = $.roundColumnBetsSum[rid][mid][2];
        liab.col3 = $.roundColumnBetsSum[rid][mid][3];
        liab.otherBetsWeightedPayout = $.roundOtherBetsWeightedPayout[rid][mid];
        return RouletteLiabilityMathLib.bufferedMarketMaxLiability(liab);
    }

}
