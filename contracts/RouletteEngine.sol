// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { VRFV2PlusClient } from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import { VRFConsumerBaseV2 } from "./external/VRFConsumerBaseV2.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { IBRBReferal } from "./interfaces/IBRBReferal.sol";
import { IRouletteBetErrors } from "./interfaces/IRouletteBetErrors.sol";
import { BetStorageLib } from "./libraries/BetStorageLib.sol";
import { RouletteBetCodecLib } from "./libraries/RouletteBetCodecLib.sol";
import { JackpotBatchLib } from "./libraries/JackpotBatchLib.sol";
import { RouletteLiabilityMathLib } from "./libraries/RouletteLiabilityMathLib.sol";
import { RouletteEngineStorageLib } from "./libraries/RouletteEngineStorageLib.sol";
import { RouletteExposureLib } from "./libraries/RouletteExposureLib.sol";
import { RoulettePayoutSweepLib } from "./libraries/RoulettePayoutSweepLib.sol";
import { RouletteJackpotCollectLib } from "./libraries/RouletteJackpotCollectLib.sol";
import { MarketFeeLib } from "./libraries/MarketFeeLib.sol";

/// @notice UUPS proxy implementation. Deploy implementation with `vrfCoordinator`, then `ERC1967Proxy` + `initialize`.
contract RouletteEngine is Initializable, AccessControlUpgradeable, UUPSUpgradeable, VRFConsumerBaseV2, IRouletteEngine {
    using BetStorageLib for BetStorageLib.RoundTotals;

    bytes32 public constant ENGINE_WITHDRAWAL_ROLE = keccak256("ENGINE_WITHDRAWAL_ROLE");
    bytes32 public constant ENGINE_PAYOUT_ROLE = keccak256("ENGINE_PAYOUT_ROLE");
    bytes32 public constant ENGINE_ROUND_ROLE = keccak256("ENGINE_ROUND_ROLE");
    bytes32 public constant ENGINE_FEE_ROLE = keccak256("ENGINE_FEE_ROLE");
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

    uint32 public constant DEFAULT_PAYOUT_LANE_COUNT = 10;

    IBRBReferal public immutable BRB_REFERRAL;
    bytes32 public immutable VRF_KEY_HASH_2_GWEI;
    bytes32 public immutable VRF_KEY_HASH_30_GWEI;
    bytes32 public immutable VRF_KEY_HASH_150_GWEI;
    uint16 public immutable VRF_CONFIRMATIONS;

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

    function referrerOf(address player) external view returns (address) {
        return _s().referrerOf[player];
    }

    function VRF_SUBSCRIPTION_ID() external view returns (uint256) {
        return _s().VRF_SUBSCRIPTION_ID;
    }

    function VRF_CALLBACK_GAS_LIMIT() external view returns (uint32) {
        return _s().VRF_CALLBACK_GAS_LIMIT;
    }

    function ROUND_DURATION() external view returns (uint32) {
        return _s().ROUND_DURATION;
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

    function INFRA_BPS() external pure returns (uint256) {
        return MarketFeeLib.INFRA_BPS;
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

    function roundPhase(uint64 roundId) external view returns (RouletteEngineStorageLib.RoundPhase) {
        return RouletteEngineStorageLib.phaseOfRound(_s(), roundId);
    }

    uint256 public constant DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE = 5;
    uint256 public constant MAX_WITHDRAWAL_QUEUE_BATCH_SIZE = 20;
    uint256 public constant DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH = 100;
    uint256 public constant MAX_MAX_WITHDRAWAL_QUEUE_LENGTH = 1000;


    error UnauthorizedScheduler();
    error UnauthorizedBank();
    error RoundIsLocked();
    error InvalidJob();
    error InvalidRound();
    error StalePayoutChunk();
    error StaleJackpotChunk();
    error ZeroAddress();
    error InvalidRoundDuration();
    error InvalidWithdrawalQueueBatchSize();
    error InvalidMaxWithdrawalQueueLength();
    error OnlyRegistry();
    error InsufficientBankForMaxPayout();
    error InvalidReferrer();
    error PayoutLaneCountLockedWhileSettling();

    event MarketRegistered(uint32 marketId, address asset, address bank);

    event VrfRequested(uint64 newRoundId, uint256 requestId, uint256 timestamp);
    event VRFResult(uint64 roundId, uint8 winningNumber, uint8 jackpotNumber);
    event RoundResolved(uint64 roundId);

    /// @dev One log per `recordBet` call; decode `betData` as `(uint256[] betTypes, uint256[] numbers, uint256[] amounts)`.
    event BetRecorded(
        uint32 marketId,
        uint64 localRound,
        address player,
        uint256 totalAmount,
        bytes betData
    );
    event RoundCountdownStarted(uint64 roundId, uint32 triggerMarketId, uint256 lockAt);
    event PayoutProgress(uint64 globalRoundId, uint32 marketId, uint256 fromCursor, uint256 toCursor, uint256 paidAmount);
    event JackpotFunded(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event InfrastructureFeePaid(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event WithdrawalQueueBatchSizeUpdated(uint256 newBatchSize);
    event MaxWithdrawalQueueLengthUpdated(uint256 newMaxLength);
    event RoundDurationUpdated(uint32 newRoundDuration);
    event PayoutLaneCountUpdated(uint32 newLaneCount);
    event ReferralSet(address player, address referrer);
    event JackpotFunderUpdated(address previousFunder, address newFunder);
    event JackpotTreasuryUpdated(address previousTreasury, address newTreasury);

    modifier onlyScheduler() {
        if (msg.sender != _s().UPKEEP_SCHEDULER) revert UnauthorizedScheduler();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != address(_s().REGISTRY)) revert OnlyRegistry();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address vrfCoordinator,
        bytes32 vrfKeyHash2Gwei,
        bytes32 vrfKeyHash30Gwei,
        bytes32 vrfKeyHash150Gwei,
        uint16 vrfConfirmations,
        address brbReferral
    ) VRFConsumerBaseV2(vrfCoordinator) {
        VRF_KEY_HASH_2_GWEI = vrfKeyHash2Gwei;
        VRF_KEY_HASH_30_GWEI = vrfKeyHash30Gwei;
        VRF_KEY_HASH_150_GWEI = vrfKeyHash150Gwei;
        VRF_CONFIRMATIONS = vrfConfirmations;
        BRB_REFERRAL = IBRBReferal(brbReferral);
        _disableInitializers();
    }

    /// @dev Opens global round `1` in `Open` phase; further rounds open automatically when the previous round completes.
    function initialize(RouletteEngineStorageLib.InitConfig calldata cfg) external initializer {
        if (
            cfg.registry == address(0) || cfg.jackpotTreasury == address(0) || cfg.jackpotFunder == address(0)
                || cfg.infraRecipient == address(0) || cfg.admin == address(0) || cfg.upkeepScheduler == address(0)
        ) revert ZeroAddress();
        if (cfg.roundDuration == 0) revert InvalidRoundDuration();

        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, cfg.admin);
        _grantRole(ENGINE_WITHDRAWAL_ROLE, cfg.admin);
        _grantRole(ENGINE_PAYOUT_ROLE, cfg.admin);
        _grantRole(ENGINE_ROUND_ROLE, cfg.admin);
        _grantRole(ENGINE_FEE_ROLE, cfg.admin);

        RouletteEngineStorageLib.Layout storage $ = _s();
        $.REGISTRY = IMarketRegistry(cfg.registry);
        $.JACKPOT_TREASURY = IJackpotTreasury(cfg.jackpotTreasury);
        $.JACKPOT_FUNDER = IBRBJackpotFunder(cfg.jackpotFunder);
        $.INFRA_RECIPIENT = cfg.infraRecipient;
        $.UPKEEP_SCHEDULER = cfg.upkeepScheduler;
        $.VRF_SUBSCRIPTION_ID = cfg.subscriptionId;
        $.VRF_CALLBACK_GAS_LIMIT = cfg.callbackGasLimit;
        $.ROUND_DURATION = cfg.roundDuration;
        $.withdrawalQueueBatchSize = DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE;
        $.maxWithdrawalQueueLength = DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH;
        $.payoutLaneCount = DEFAULT_PAYOUT_LANE_COUNT;
        $._globalRound = 1;
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Open;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @inheritdoc IRouletteEngine
    function isBankLiquidityRestricted(uint32 marketId) public view returns (bool) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 r = $._globalRound;
        if (!$._roundHasMarket[r][marketId]) return false;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Settling) return false;
        return !$.marketRoundStateByRound[r][marketId].settled;
    }

    function setWithdrawalQueueBatchSize(uint256 newBatchSize) external onlyRole(ENGINE_WITHDRAWAL_ROLE) {
        if (newBatchSize == 0 || newBatchSize > MAX_WITHDRAWAL_QUEUE_BATCH_SIZE) revert InvalidWithdrawalQueueBatchSize();
        _s().withdrawalQueueBatchSize = newBatchSize;
        emit WithdrawalQueueBatchSizeUpdated(newBatchSize);
    }

    function setMaxWithdrawalQueueLength(uint256 newMaxLength) external onlyRole(ENGINE_WITHDRAWAL_ROLE) {
        if (newMaxLength == 0 || newMaxLength > MAX_MAX_WITHDRAWAL_QUEUE_LENGTH) revert InvalidMaxWithdrawalQueueLength();
        _s().maxWithdrawalQueueLength = newMaxLength;
        emit MaxWithdrawalQueueLengthUpdated(newMaxLength);
    }

    function setPayoutLaneCount(uint32 newLaneCount) external onlyRole(ENGINE_PAYOUT_ROLE) {
        if (newLaneCount == 0) revert InvalidJob();
        RouletteEngineStorageLib.Layout storage $ = _s();
        // Reject changes during Settling: the winning-shard partitioning is snapshotted with the
        // current lane count at VRF resolution and the payout sweep re-reads it while the round is
        // Settling. Changing it mid-settlement desyncs the two and permanently stalls the round.
        // Open/Locked/Completed are safe — the next round's snapshot uses the new count consistently.
        if ($._roundPhase == RouletteEngineStorageLib.RoundPhase.Settling) {
            revert PayoutLaneCountLockedWhileSettling();
        }
        $.payoutLaneCount = newLaneCount;
        emit PayoutLaneCountUpdated(newLaneCount);
    }

    /// @inheritdoc IRouletteEngine
    function payoutParallelLaneCount() external view returns (uint32) {
        uint32 n = _s().payoutLaneCount;
        return n == 0 ? 1 : n;
    }

    /// @notice Updates betting countdown length for rounds that have not yet started their lock timer.
    function setRoundDuration(uint32 newRoundDuration) external onlyRole(ENGINE_ROUND_ROLE) {
        if (newRoundDuration == 0) revert InvalidRoundDuration();
        _s().ROUND_DURATION = newRoundDuration;
        emit RoundDurationUpdated(newRoundDuration);
    }

    /// @notice Point fee collection at a new `BRBJackpotFunder` (e.g. router/TWAP policy upgrade). Sweep the old funder before deprecating it.
    function setJackpotFunder(address newFunder) external onlyRole(ENGINE_FEE_ROLE) {
        if (newFunder == address(0)) revert ZeroAddress();
        RouletteEngineStorageLib.Layout storage $ = _s();
        address previous = address($.JACKPOT_FUNDER);
        $.JACKPOT_FUNDER = IBRBJackpotFunder(newFunder);
        emit JackpotFunderUpdated(previous, newFunder);
    }

    /// @notice Point jackpot BRB payouts at a new treasury (must trust `newTreasury` onlyEngine = this proxy).
    function setJackpotTreasury(address newTreasury) external onlyRole(ENGINE_FEE_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        RouletteEngineStorageLib.Layout storage $ = _s();
        address previous = address($.JACKPOT_TREASURY);
        $.JACKPOT_TREASURY = IJackpotTreasury(newTreasury);
        emit JackpotTreasuryUpdated(previous, newTreasury);
    }

    function registerMarketFromRegistry(uint32 marketId, address bank) external onlyRegistry {
        _registerMarket(marketId, bank);
    }

    function _registerMarket(uint32 marketId, address bank) private {
        IMarketRegistry.MarketConfig memory cfg = _s().REGISTRY.getMarket(marketId);
        if (bank != cfg.bank) revert InvalidRound();
        emit MarketRegistered(marketId, cfg.asset, bank);
    }

    function recordBet(
        uint32 marketId,
        address player,
        uint256 amount,
        bytes calldata betData,
        address referral
    ) external {
        // Single registry read serves both the caller auth check and the solvency check below.
        IMarketRegistry.MarketConfig memory cfg = _s().REGISTRY.getMarket(marketId);
        if (cfg.bank != msg.sender) revert UnauthorizedBank();
        _recordBetInternal(marketId, player, amount, betData, cfg);
        _applyReferral(player, amount, referral);
    }

    function _recordBetInternal(
        uint32 marketId,
        address player,
        uint256 amount,
        bytes calldata betData,
        IMarketRegistry.MarketConfig memory cfg
    ) private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = _resolveOpenRound($, marketId);
        RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
        if ($._roundTriggerMarket[roundId] == 0) {
            $._roundTriggerMarket[roundId] = marketId;
            uint256 lockAt = block.timestamp + $.ROUND_DURATION;
            $._roundLockAt[roundId] = lockAt;
            emit RoundCountdownStarted(roundId, marketId, lockAt);
        }

        uint256 runningSum = _recordMultiBetPayload($, roundId, marketId, player, betData);
        if (runningSum != amount) revert IRouletteBetErrors.InvalidBetNumber();
        mr.totals.addBet(amount);
        emit BetRecorded(marketId, roundId, player, amount, betData);

        // Bets are recorded before the vault pulls tokens; solvency is checked against balance after this transfer.
        uint256 bankBal = IERC20(cfg.asset).balanceOf(cfg.bank);
        if (bankBal + amount < _bufferedMarketMaxLiability($, roundId, marketId)) {
            revert InsufficientBankForMaxPayout();
        }
    }

    function _applyReferral(address player, uint256 amount, address referral) private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        if (referral != address(0)) {
            if (referral == player) revert InvalidReferrer();
            if ($.referrerOf[player] == address(0)) {
                $.referrerOf[player] = referral;
                emit ReferralSet(player, referral);
            }
        }
        address bound = $.referrerOf[player];
        if (bound != address(0)) {
            BRB_REFERRAL.mint(bound, amount);
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

        uint256 a;
        for (uint256 i; i < len; ) {
            a = amounts[i];
            runningSum += a;
            _recordSingleBet($, roundId, marketId, player, a, betTypes[i], numbers[i]);
            unchecked { ++i; }
        }
    }

    function _recordSingleBet(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint32 marketId,
        address player,
        uint256 amount,
        uint256 betTypeRaw,
        uint256 numberRaw
    ) private {
        if (amount == 0) revert IRouletteBetErrors.ZeroBetAmount();
        if (betTypeRaw == 0 || betTypeRaw > BET_TRIO_023) revert IRouletteBetErrors.InvalidBetType();
        RouletteBetCodecLib.validateBetNumber(betTypeRaw, numberRaw);
        RouletteEngineStorageLib.BetEntry memory bet =
            RouletteEngineStorageLib.BetEntry(player, uint128(amount), uint8(betTypeRaw), uint16(numberRaw));
        _recordBetEntry($, roundId, marketId, bet);
        RouletteExposureLib.accumulate($, roundId, marketId, bet.betType, bet.number, bet.amount);
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

    /// @notice Per-lane payout scan: each lane picks the first unsettled market where *that lane* still has work.
    ///         Markets can therefore settle in parallel across lanes (separate vaults per market).
    function _findPayoutJobForLane(
        uint32 payoutLane,
        uint32 laneCount
    ) private view returns (bool found, Job memory job) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Settling) return (false, job);

        uint64 roundId = $._globalRound;
        if (!$.globalRoundState[roundId].vrfFulfilled) return (false, job);

        uint32 totalMarkets = $.REGISTRY.marketCount();
        for (uint32 marketId = 1; marketId <= totalMarkets; ) {
            RouletteEngineStorageLib.MarketRoundState storage mr = $.marketRoundStateByRound[roundId][marketId];
            if (!mr.settled && mr.totals.betCount > 0) {
                // nextCursor carries the shard's current payout cursor so apply can reject stale (raced) chunks.
                Job memory candidate = _payoutJob(
                    roundId,
                    marketId,
                    uint32($.payoutCursorByShard[roundId][marketId][payoutLane]),
                    payoutLane,
                    laneCount
                );
                if (_payoutLaneHasWork(candidate)) return (true, candidate);
            }
            unchecked {
                ++marketId;
            }
        }
        return (false, job);
    }

    /// @notice Global payout scan; lanes may service different markets when a lane has no shard work left on earlier ids.
    function _findNextJob(uint32 startCursor, uint32, uint32 payoutLane) private view returns (bool found, Job memory job) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint32 totalMarkets = $.REGISTRY.marketCount();
        if (totalMarkets == 0) return (false, job);

        uint32 laneCount = $.payoutLaneCount;
        if (laneCount == 0) laneCount = 1;
        if (payoutLane >= laneCount) return (false, job);

        (bool foundPayout, Job memory payoutJob) = _findPayoutJobForLane(payoutLane, laneCount);
        if (foundPayout) return (true, payoutJob);

        if (payoutLane != 0) return (false, job);

        uint64 roundId = $._globalRound;
        if (_vrfTriggerUpkeepCandidate($, roundId)) {
            return (true, Job({
                kind: JobKind.TriggerVrf,
                marketId: 0,
                roundId: roundId,
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }
        return (false, job);
    }

    /// @dev Predicate for `JobKind.TriggerVrf`: round countdown elapsed with at least one bet and VRF not yet requested.
    function _vrfTriggerUpkeepCandidate(RouletteEngineStorageLib.Layout storage $, uint64 roundId) private view returns (bool) {
        if ($._pendingRequestId != 0) return false;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) return false;
        if ($.globalRoundState[roundId].vrfRequested) return false;
        uint32 triggerMarketId = $._roundTriggerMarket[roundId];
        if (triggerMarketId == 0) return false;
        uint256 lockAt = $._roundLockAt[roundId];
        if (lockAt == 0 || block.timestamp < lockAt) return false;
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
        return _previewPayoutBundle(job, maxPayoutsPerCall);
    }

    function _previewPayoutBundle(Job memory job, uint32 maxPayoutsPerCall)
        internal
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
        return _payoutLaneHasWork(job);
    }

    function _payoutLaneHasWork(Job memory job) internal view returns (bool) {
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
                RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, gr.winningNumber);
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
        IBankVault.Payout[] memory winnerPayoutRows,
        address[] memory jackpotWinners,
        uint256[] memory jackpotAmounts
    ) external onlyScheduler returns (bool) {
        if (job.kind == JobKind.TriggerVrf) {
            _triggerVrf();
            return true;
        }
        if (job.kind == JobKind.Payout) {
            _applyPreparedPayout(job, winnerPayoutRows, jackpotWinners, jackpotAmounts);
            return true;
        }
        return false;
    }

    function currentGlobalRound() external view returns (uint64) { return _s()._globalRound; }

    /// @inheritdoc IRouletteEngine
    function roundOutcome(uint64 roundId) external view returns (bool vrfFulfilled, uint8 winningNumber) {
        RouletteEngineStorageLib.GlobalRoundState storage gr = _s().globalRoundState[roundId];
        return (gr.vrfFulfilled, gr.winningNumber);
    }

    /// @inheritdoc IRouletteEngine
    function roundJackpotTriggered(uint64 roundId) external view returns (bool vrfFulfilled, bool jackpotTriggered) {
        RouletteEngineStorageLib.GlobalRoundState storage gr = _s().globalRoundState[roundId];
        return (gr.vrfFulfilled, gr.jackpotTriggered);
    }

    /// @notice Current vault payout cursor for a shard (also snapshotted into payout jobs' `nextCursor`).
    function payoutShardCursor(uint64 roundId, uint32 marketId, uint32 lane) external view returns (uint256) {
        return _s().payoutCursorByShard[roundId][marketId][lane];
    }

    function hasPendingVrf() external view returns (bool) { return _s()._pendingRequestId != 0; }
    function vrfActiveRound() external view returns (uint64) {
        RouletteEngineStorageLib.Layout storage $ = _s();
        return $._pendingRequestId != 0 ? $._globalRound : 0;
    }

    function _resolveOpenRound(RouletteEngineStorageLib.Layout storage $, uint32 marketId) private returns (uint64 roundId) {
        roundId = $._globalRound;
        if ($._roundPhase != RouletteEngineStorageLib.RoundPhase.Open) revert RoundIsLocked();
        // Reject bets once the countdown elapsed, even before the TriggerVrf upkeep lands.
        uint256 lockAt = $._roundLockAt[roundId];
        if (lockAt != 0 && block.timestamp >= lockAt) revert RoundIsLocked();
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

    /// @dev Locks the betting round and requests VRF in one step (single automation round-trip).
    /// Guard makes duplicate/raced TriggerVrf reports revert instead of double-requesting randomness.
    function _triggerVrf() private {
        RouletteEngineStorageLib.Layout storage $ = _s();
        uint64 roundId = $._globalRound;
        if (
            $._roundPhase != RouletteEngineStorageLib.RoundPhase.Open
                || $.globalRoundState[roundId].vrfRequested
        ) revert InvalidRound();

        $.globalRoundState[roundId].vrfRequested = true;
        $._roundPhase = RouletteEngineStorageLib.RoundPhase.Settling;

        uint256 req = vrfCoordinator().requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: tx.gasprice < 2 gwei
            ? VRF_KEY_HASH_2_GWEI
            : tx.gasprice < 30 gwei ? VRF_KEY_HASH_30_GWEI : VRF_KEY_HASH_150_GWEI,
                subId: $.VRF_SUBSCRIPTION_ID,
                requestConfirmations: VRF_CONFIRMATIONS,
                callbackGasLimit: $.VRF_CALLBACK_GAS_LIMIT,
                numWords: 2,
                extraArgs: ""
            })
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

        emit VRFResult(roundId, winningNumber, jackpotNumber);
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

        uint32 lane = job.payoutShardIndex;
        uint32 laneCount = job.payoutShardWidth;

        // Defence in depth: the job is rebuilt off-chain and delivered through the CRE report, so
        // re-assert the round context `previewPayoutBundle` relied on before moving any funds.
        // A stale job (old round, VRF not in yet, market already settled) is treated as a no-op
        // rather than a revert, matching how repeated lane executions already behave — the point is
        // that it must not pay anything, not that it must fail loudly.
        if (roundId != $._globalRound || !gr.vrfFulfilled || mr.settled) return;
        // A malformed job is a different matter: `laneCount == 0` made `_allPayoutShardsComplete`
        // vacuously true, finalizing a market whose winners were never paid.
        if (laneCount == 0 || lane >= laneCount) revert InvalidJob();

        if (!mr.betsReleased) {
            IBankVault(bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }

        if (lane == 0 && jackpotWinners.length != 0) {
            _applyJackpotChunkPrepared($, roundId, marketId, gr.winningNumber, gr, jackpotWinners, jackpotAmounts);
        }

        uint256 n = winnerPayoutRows.length;
        if (n == 0) {
            if (mr.winningBetCount == 0 && _allPayoutShardsComplete($, roundId, marketId, laneCount)) {
                _finalizeMarketSettlement($, roundId, marketId, bank, mr);
            }
            return;
        }

        uint256 start = $.payoutCursorByShard[roundId][marketId][lane];
        // Rows were built in checkUpkeep for the cursor snapshotted into job.nextCursor; a concurrent
        // execution of the same lane may have advanced the cursor since — applying stale rows would
        // double-pay one chunk and skip another.
        if (start != uint256(job.nextCursor)) revert StalePayoutChunk();
        uint256 bankPaid = IBankVault(bank).payoutBatch(winnerPayoutRows);
        uint256 end = start + n;
        $.payoutCursorByShard[roundId][marketId][lane] = end;
        mr.bankPaidRunning += bankPaid;
        emit PayoutProgress(roundId, marketId, start, end, bankPaid);

        if (end >= $.winningBetCountByShard[roundId][marketId][lane] && _allPayoutShardsComplete($, roundId, marketId, laneCount)) {
            _finalizeMarketSettlement($, roundId, marketId, bank, mr);
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
        RouletteEngineStorageLib.MarketRoundState storage mr
    ) private {
        if (mr.settled) return;
        _collectMarketFees($, roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
        mr.settled = true;
        unchecked {
            ++$._roundMarketsSettledCount[roundId];
        }
        IBankVault(bank).processWithdrawalQueue($.withdrawalQueueBatchSize);
        _tryCompleteGlobalRound($, roundId);
    }

    /// @dev Opens the next global round only after every participating market is settled — never two unpaid rounds.
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
        MarketFeeLib.CollectResult memory fees = MarketFeeLib.collect(
            $.JACKPOT_FUNDER, $.INFRA_RECIPIENT, bank, marketId, totalBets, bankPaid
        );
        if (fees.swapIn > 0) emit JackpotFunded(roundId, marketId, fees.swapIn);
        if (fees.infraFee > 0) emit InfrastructureFeePaid(roundId, marketId, fees.infraFee);
    }

    function _previewJackpotPayouts(
        RouletteEngineStorageLib.Layout storage $,
        uint64 roundId,
        uint8 winningNumber,
        uint32 maxPayoutsPerCall
    ) private view returns (address[] memory jackpotWinners, uint256[] memory jackpotAmounts) {
        RouletteEngineStorageLib.GlobalRoundState storage gr = $.globalRoundState[roundId];
        (address[] memory winners, uint256[] memory stakes, uint256 totalStake) =
            RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, winningNumber);
        uint256 n = winners.length;
        if (n == 0) return (jackpotWinners, jackpotAmounts);

        uint256 pool0 = gr.jackpotPoolSnapshot;
        if (pool0 == 0) pool0 = $.JACKPOT_TREASURY.jackpotPool();
        uint256 denom = gr.jackpotTotalStake;
        if (denom == 0) denom = totalStake;
        // Defence in depth: with no eligible stake weight the proportional share is undefined.
        // Skip distribution rather than divide by zero (mirrors `_payoutLaneHasWork`'s totalStake > 0 gate).
        if (denom == 0) return (jackpotWinners, jackpotAmounts);

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
        uint32 marketId,
        uint8 winningNumber,
        RouletteEngineStorageLib.GlobalRoundState storage gr,
        address[] memory winners,
        uint256[] memory amounts
    ) private {
        // The preview gates the jackpot on both of these; the apply path gated on neither, so a
        // payload carrying jackpot rows reached the treasury on rounds where no jackpot ever fired.
        if (!gr.jackpotTriggered) revert StaleJackpotChunk();
        if (marketId != $._roundTriggerMarket[roundId]) revert StaleJackpotChunk();
        if (gr.jackpotDistributed) revert StaleJackpotChunk();
        if (gr.jackpotPoolSnapshot == 0) {
            (address[] memory allWinners,, uint256 totalStake) =
                RouletteJackpotCollectLib.collectJackpotEligibleStraightStakes($, roundId, winningNumber);
            gr.jackpotPoolSnapshot = $.JACKPOT_TREASURY.jackpotPool();
            gr.jackpotTotalStake = totalStake;
            gr.jackpotWinnerCount = uint32(allWinners.length);
        }
        // A raced duplicate of an already-applied chunk would overrun the winner count.
        if (uint256(gr.jackpotCursor) + winners.length > gr.jackpotWinnerCount) revert StaleJackpotChunk();

        // The winner count bounds how many rows may be paid, but not how much: bound the chunk by
        // what is left of this round's snapshotted pool so a single row cannot drain the treasury.
        uint256 requested;
        for (uint256 i; i < amounts.length; ) {
            requested += amounts[i];
            unchecked {
                ++i;
            }
        }
        uint256 remainingPool = gr.jackpotPoolSnapshot > gr.jackpotPaid ? gr.jackpotPoolSnapshot - gr.jackpotPaid : 0;
        if (requested > remainingPool) revert StaleJackpotChunk();

        uint256 paid = $.JACKPOT_TREASURY.payBatch(winners, amounts);
        gr.jackpotPaid += paid;
        gr.jackpotCursor += uint32(winners.length);
        if (gr.jackpotCursor >= gr.jackpotWinnerCount) gr.jackpotDistributed = true;
    }

    function _isRoundDone(RouletteEngineStorageLib.Layout storage $, uint64 roundId) internal view returns (bool) {
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
