// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { VRFCoordinatorV2Interface } from "@chainlink/contracts/src/v0.8/vrf/interfaces/VRFCoordinatorV2Interface.sol";
import { VRFConsumerBaseV2 } from "./external/VRFConsumerBaseV2.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";
import { BetStorageLib } from "./libraries/BetStorageLib.sol";
import { RouletteBetLib } from "./libraries/RouletteBetLib.sol";
import { RouletteLib } from "./RouletteLib.sol";

contract RouletteEngine is AccessControl, VRFConsumerBaseV2, IRouletteEngine {
    using BetStorageLib for BetStorageLib.RoundTotals;

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
        /// @dev Cursor into the flattened winner stream (straight → splits → …); not raw bet ledger.
        uint256 payoutCursor;
        /// @dev Length of flattened winner stream; fixed when VRF lands.
        uint256 winningBetCount;
        uint256 bankPaidRunning;
        bool settled;
        BetStorageLib.RoundTotals totals;
    }

    struct BatchResult {
        uint256 bankPaid;
        uint256 payoutsCount;
    }

    /// @dev ABI-compatible with legacy `StakedBRB.RoundCleaningCompleted` tuple.
    struct LegacyFees {
        uint256 protocolFees;
        uint256 burnAmount;
        uint256 jackpotAmount;
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

    /// @dev Carries traversal state across bucket sweeps (`gPos`: global ordinal in flattened winner stream).
    struct PayoutSweepCtx {
        uint64 rid;
        uint32 mid;
        uint256 cursorStart;
        uint256 payoutMax;
        uint256 gPos;
        uint256 payoutCount;
    }

    enum RoundPhase {
        Unset,
        Open,
        Locked,
        Settling,
        Completed
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

    IMarketRegistry public immutable REGISTRY;
    IJackpotTreasury public immutable JACKPOT_TREASURY;
    IBRBJackpotFunder public immutable JACKPOT_FUNDER;
    uint256 private constant JACKPOT_RATIO_SCALE = 1e18;
    VRFCoordinatorV2Interface public immutable VRF_COORDINATOR;
    uint256 public immutable VRF_SUBSCRIPTION_ID;
    bytes32 public immutable VRF_KEY_HASH;
    uint32 public immutable VRF_CALLBACK_GAS_LIMIT;
    uint16 public immutable VRF_CONFIRMATIONS;
    uint32 public immutable ROUND_DURATION;

    uint64 private _globalRound;
    uint256 private _pendingRequestId;
    uint64 private _activeVrfRound;
    uint64[] private _vrfQueue;
    uint256 private _vrfQueueHead;
    uint256 public minJackpotBet;

    /// @notice Shared across all markets: max withdrawals finalized per bank per settlement batch.
    uint256 public withdrawalQueueBatchSize;
    /// @notice Shared across all markets: max queued withdrawal owners per bank.
    uint256 public maxWithdrawalQueueLength;

    uint256 public constant DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE = 5;
    uint256 public constant MAX_WITHDRAWAL_QUEUE_BATCH_SIZE = 20;
    uint256 public constant DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH = 100;
    uint256 public constant MAX_MAX_WITHDRAWAL_QUEUE_LENGTH = 1000;

    /// @dev When >1, `findNextJob(..., lane, width)` routes non-overlapping payout shards by `shardIndex % laneCount`.
    /// Default `1` keeps legacy single-cursor payout behavior (feature off).
    uint32 public payoutParallelLaneCount = 1;
    /// @dev Bit N set when payout shard N finished for {round, market} (parallel mode only).
    uint256 public constant MAX_PARALLEL_PAYOUT_SHARDS = 256;
    uint32 private constant PAYOUT_SHARD_JACKPOT = type(uint32).max;

    address public immutable INFRA_RECIPIENT;

    mapping(uint64 => GlobalRoundState) public globalRoundState;
    mapping(uint64 => mapping(uint32 => MarketRoundState)) public marketRoundStateByRound;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) public roundStraightBetsSum;
    /// @dev Per {RouletteLib.maxLiabilityRaw}: max total straight stake on any single number this round.
    mapping(uint64 => mapping(uint32 => uint256)) private roundMaxStraightBet;
    mapping(uint64 => mapping(uint32 => uint256)) private roundMaxStreetBet;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) private roundStreetBetsTotal;
    mapping(uint64 => mapping(uint32 => uint256)) private roundRedBetsSum;
    mapping(uint64 => mapping(uint32 => uint256)) private roundBlackBetsSum;
    mapping(uint64 => mapping(uint32 => uint256)) private roundOddBetsSum;
    mapping(uint64 => mapping(uint32 => uint256)) private roundEvenBetsSum;
    mapping(uint64 => mapping(uint32 => uint256)) private roundLowBetsSum;
    mapping(uint64 => mapping(uint32 => uint256)) private roundHighBetsSum;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) private roundDozenBetsSum;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) private roundColumnBetsSum;
    /// @dev Σ(amount * payoutMultiplier) for split/corner/line/trio bets (legacy conservative bound).
    mapping(uint64 => mapping(uint32 => uint256)) private roundOtherBetsWeightedPayout;
    mapping(uint64 => mapping(uint32 => mapping(uint8 => mapping(uint256 => BetEntry[])))) private roundNumberedBets;
    mapping(uint64 => mapping(uint32 => mapping(uint8 => BetEntry[]))) private roundFlatBets;
    mapping(uint64 => uint32[]) private _roundMarkets;
    /// @dev Distinct markets that placed at least one bet in this open round (incremented in `_resolveOpenRound`).
    mapping(uint64 => uint32) private _roundMarketParticipantCount;
    /// @dev Reaches `_roundMarketParticipantCount[r]` when each of those markets finishes settlement.
    mapping(uint64 => uint32) private _roundMarketsSettledCount;
    mapping(uint64 => mapping(uint32 => bool)) private _roundHasMarket;
    mapping(uint64 => uint32) private _roundTriggerMarket;
    mapping(uint64 => uint40) private _roundLockAt;
    mapping(uint64 => mapping(uint32 => uint256)) private payoutShardsDone;
    /// @dev Scan lower bound for pending payout `{roundId, marketId}` (~amortizes `_findFirstPayout` across deep round history).
    uint64 private _payoutFinderRound;
    uint32 private _payoutFinderMarket;
    mapping(uint64 => RoundPhase) public roundPhase;
    mapping(uint256 => uint64) public requestIdToGlobalRound;
    mapping(uint64 => bool) private _legacyFirstBetPlaced;

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
    error InvalidBetType();
    error InvalidBetNumber();
    error InvalidRoundDuration();
    error InvalidWithdrawalQueueBatchSize();
    error InvalidMaxWithdrawalQueueLength();
    error InvalidPayoutParallelLaneCount();
    error TooManyPayoutShards();
    error OnlyRegistry();
    error InsufficientBankForMaxPayout();
    error UnexpectedWinnerAttachment();

    event SchedulerRegistered(address scheduler, bool allowed);
    event MarketRegistered(uint32 marketId, address bank);

    /// @notice Legacy indexer / subgraph events (ABI aligned with references `OldRouletteClean.sol` / `StakedBRB.sol`).
    event VrfRequested(uint256 newRoundId, uint256 requestId, uint256 timestamp);
    event VRFResult(uint256 roundId, uint256 winningNumber, uint256 jackpotNumber);
    event JackpotResultEvent(uint256 roundId, uint256 jackpotWinnerCount);
    event ComputedPayouts(uint256 roundId, uint256 totalWinningBets);
    event RoundResolved(uint256 roundId);
    event BettingWindowClosed(uint256 roundId);
    event RoundCleaningCompleted(
        uint256 cleanedRoundId,
        uint256 newRoundId,
        uint256 boundaryTimestamp,
        LegacyFees fees
    );
    event FirstBetPlaced(uint256 roundId, uint256 timestamp);

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
    event PayoutProgress(uint64 globalRoundId, uint32 marketId, uint32 fromCursor, uint32 toCursor, uint256 paidAmount);
    event JackpotFunded(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event InfrastructureFeePaid(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event WithdrawalQueueBatchSizeUpdated(uint256 newBatchSize);
    event MaxWithdrawalQueueLengthUpdated(uint256 newMaxLength);
    event PayoutParallelLaneCountUpdated(uint32 newLaneCount);

    modifier onlyScheduler() {
        if (!hasRole(SCHEDULER_ROLE, msg.sender)) revert UnauthorizedScheduler();
        _;
    }

    modifier onlyBank(uint32 marketId) {
        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        if (cfg.bank != msg.sender) revert UnauthorizedBank();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != address(REGISTRY)) revert OnlyRegistry();
        _;
    }

    constructor(
        address registry,
        address jackpotTreasury,
        address jackpotFunder,
        address infraRecipient,
        address vrfCoordinator,
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 confirmations,
        uint32 roundDuration,
        address admin
    ) VRFConsumerBaseV2(vrfCoordinator) {
        if (
            registry == address(0) || jackpotTreasury == address(0) || jackpotFunder == address(0)
                || infraRecipient == address(0) || vrfCoordinator == address(0) || admin == address(0)
        ) revert ZeroAddress();
        if (roundDuration == 0) revert InvalidRoundDuration();
        REGISTRY = IMarketRegistry(registry);
        JACKPOT_TREASURY = IJackpotTreasury(jackpotTreasury);
        JACKPOT_FUNDER = IBRBJackpotFunder(jackpotFunder);
        INFRA_RECIPIENT = infraRecipient;
        VRF_COORDINATOR = VRFCoordinatorV2Interface(vrfCoordinator);
        VRF_SUBSCRIPTION_ID = subscriptionId;
        VRF_KEY_HASH = keyHash;
        VRF_CALLBACK_GAS_LIMIT = callbackGasLimit;
        VRF_CONFIRMATIONS = confirmations;
        ROUND_DURATION = roundDuration;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ENGINE_ADMIN_ROLE, admin);

        withdrawalQueueBatchSize = DEFAULT_WITHDRAWAL_QUEUE_BATCH_SIZE;
        maxWithdrawalQueueLength = DEFAULT_MAX_WITHDRAWAL_QUEUE_LENGTH;
    }

    /// @inheritdoc IRouletteEngine
    function isBankLiquidityRestricted(uint32 marketId) public view returns (bool) {
        uint64 r = _globalRound;
        if (r == 0) return false;
        if (!_roundHasMarket[r][marketId]) return false;
        RoundPhase ph = roundPhase[r];
        if (ph != RoundPhase.Locked && ph != RoundPhase.Settling) return false;
        return !marketRoundStateByRound[r][marketId].settled;
    }

    function setWithdrawalQueueBatchSize(uint256 newBatchSize) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (newBatchSize == 0 || newBatchSize > MAX_WITHDRAWAL_QUEUE_BATCH_SIZE) revert InvalidWithdrawalQueueBatchSize();
        withdrawalQueueBatchSize = newBatchSize;
        emit WithdrawalQueueBatchSizeUpdated(newBatchSize);
    }

    function setMaxWithdrawalQueueLength(uint256 newMaxLength) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (newMaxLength == 0 || newMaxLength > MAX_MAX_WITHDRAWAL_QUEUE_LENGTH) revert InvalidMaxWithdrawalQueueLength();
        maxWithdrawalQueueLength = newMaxLength;
        emit MaxWithdrawalQueueLengthUpdated(newMaxLength);
    }

    /// @notice Global payout worker count for Chainlink Automation (not per-market). Set to `1` to disable sharding.
    function setPayoutParallelLaneCount(uint32 lanes) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (lanes == 0 || lanes > 32) revert InvalidPayoutParallelLaneCount();
        payoutParallelLaneCount = lanes;
        emit PayoutParallelLaneCountUpdated(lanes);
    }

    function registerScheduler(address scheduler, bool allowed) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (scheduler == address(0)) revert ZeroAddress();
        if (allowed) _grantRole(SCHEDULER_ROLE, scheduler);
        else _revokeRole(SCHEDULER_ROLE, scheduler);
        emit SchedulerRegistered(scheduler, allowed);
    }

    function setMinJackpotBet(uint256 newMinJackpotBet) external onlyRole(ENGINE_ADMIN_ROLE) {
        minJackpotBet = newMinJackpotBet;
        emit MinJackpotConditionUpdated(newMinJackpotBet);
    }

    function registerMarketFromRegistry(uint32 marketId, address bank) external onlyRegistry {
        _registerMarket(marketId, bank);
    }

    function _registerMarket(uint32 marketId, address bank) private {
        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        if (bank != cfg.bank) revert InvalidRound();
        emit MarketRegistered(marketId, bank);
    }

    function recordBet(uint32 marketId, address player, uint256 amount, bytes calldata betData) external onlyBank(marketId) {
        uint64 roundId = _resolveOpenRound(marketId);
        if (roundPhase[roundId] != RoundPhase.Open) revert RoundIsLocked();
        if (_preLockUpkeepCandidate(roundId)) revert BettingClosedAwaitingSeal();
        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
        if (_roundTriggerMarket[roundId] == 0) {
            _roundTriggerMarket[roundId] = marketId;
            _roundLockAt[roundId] = uint40(block.timestamp + uint256(ROUND_DURATION));
        }

        uint256 runningSum = _recordMultiBetPayload(roundId, marketId, player, betData);
        if (runningSum != amount) revert InvalidBetNumber();
        mr.totals.addBet(amount);

        // Bets are recorded before the vault pulls tokens; solvency is checked against balance after this transfer.
        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        uint256 bankBal = IERC20(cfg.asset).balanceOf(cfg.bank);
        if (bankBal + amount < _bufferedMarketMaxLiability(roundId, marketId)) {
            revert InsufficientBankForMaxPayout();
        }

        if (!_legacyFirstBetPlaced[roundId]) {
            _legacyFirstBetPlaced[roundId] = true;
            emit FirstBetPlaced(uint256(roundId), block.timestamp);
        }
    }

    function _recordMultiBetPayload(uint64 roundId, uint32 marketId, address player, bytes calldata betData)
        private
        returns (uint256 runningSum)
    {
        (uint256[] memory betTypes, uint256[] memory numbers, uint256[] memory amounts) =
            abi.decode(betData, (uint256[], uint256[], uint256[]));
        uint256 len = betTypes.length;
        if (len == 0 || numbers.length != len || amounts.length != len) revert InvalidBetType();

        for (uint256 i; i < len; ) {
            uint256 a = amounts[i];
            runningSum += a;
            _recordAndEmitBet(roundId, marketId, player, a, betTypes[i], numbers[i]);
            unchecked { ++i; }
        }
    }

    function _recordAndEmitBet(
        uint64 roundId,
        uint32 marketId,
        address player,
        uint256 amount,
        uint256 betTypeRaw,
        uint256 numberRaw
    ) private {
        if (betTypeRaw == 0 || betTypeRaw > BET_TRIO_023) revert InvalidBetType();
        _validateBetNumber(betTypeRaw, numberRaw);
        uint8 betType = uint8(betTypeRaw);
        uint16 number = uint16(numberRaw);
        BetEntry memory bet = BetEntry(player, uint128(amount), betType, number);
        _recordBetEntry(roundId, marketId, bet);
        _accumulateWorstCaseExposure(roundId, marketId, bet.betType, bet.number, bet.amount);
        emit BetRecorded(marketId, roundId, player, amount, betType, number);
    }

    function _recordBetEntry(uint64 roundId, uint32 marketId, BetEntry memory bet) private {
        (bool isNumbered, uint8 bucket) = _routeBet(bet.betType);
        if (isNumbered) {
            roundNumberedBets[roundId][marketId][bucket][bet.number].push(bet);
            if (bet.betType == BET_STRAIGHT) {
                roundStraightBetsSum[roundId][marketId][bet.number] += uint256(bet.amount);
            }
        } else {
            roundFlatBets[roundId][marketId][bucket].push(bet);
        }
    }

    function findNextJob(uint32 startCursor, uint32 scanLimit) external view returns (bool found, Job memory job) {
        return _findNextJob(startCursor, scanLimit, 0, 0);
    }

    /// @inheritdoc IRouletteEngine
    function findNextJob(
        uint32 startCursor,
        uint32 scanLimit,
        uint32 payoutLane,
        uint32 payoutShardWidth
    ) external view returns (bool found, Job memory job) {
        return _findNextJob(startCursor, scanLimit, payoutLane, payoutShardWidth);
    }

    /// @notice Global payout scan across rounds/markets (`scanLimit == 0` treated as default budget).
    function _findNextJob(
        uint32 startCursor,
        uint32 scanLimit,
        uint32 payoutLane,
        uint32 payoutShardWidth
    ) private view returns (bool found, Job memory job) {
        uint32 totalMarkets = REGISTRY.marketCount();
        if (totalMarkets == 0) return (false, job);

        if (_globalRound == 0 || roundPhase[_globalRound] == RoundPhase.Completed) {
            return (true, Job({
                kind: JobKind.OpenRound,
                marketId: 0,
                roundId: 0,
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }

        uint32 lanesCfg = payoutParallelLaneCount;
        bool parallelDesired = payoutShardWidth > 0 && lanesCfg > 1 && payoutLane < lanesCfg;
        if (!parallelDesired && payoutShardWidth > 0 && lanesCfg > 1 && payoutLane >= lanesCfg) {
            return (false, job);
        }

        (uint64 payoutRound, uint32 payoutMarket) = _findFirstPayout(totalMarkets);

        if (payoutRound != 0) {
            if (parallelDesired) {
                uint32 budget = scanLimit == 0 ? 200 : scanLimit;
                (bool pf, Job memory pj) =
                    _findParallelPayoutWork(totalMarkets, payoutLane, payoutShardWidth, budget);
                if (pf) return (true, pj);
                return (false, job);
            }
            return (true, Job({
                kind: JobKind.Payout,
                marketId: payoutMarket,
                roundId: payoutRound,
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }

        if (_pendingRequestId == 0 && _vrfQueueHead < _vrfQueue.length) {
            return (true, Job({
                kind: JobKind.TriggerVrf,
                marketId: 0,
                roundId: _vrfQueue[_vrfQueueHead],
                nextCursor: startCursor,
                payoutShardIndex: 0,
                payoutShardWidth: 0
            }));
        }

        uint64 roundId = _globalRound;
        if (_preLockUpkeepCandidate(roundId)) {
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
    function _preLockUpkeepCandidate(uint64 roundId) private view returns (bool) {
        if (roundId == 0 || roundPhase[roundId] != RoundPhase.Open) return false;
        uint32 triggerMarketId = _roundTriggerMarket[roundId];
        if (triggerMarketId == 0) return false;
        uint40 lockAt = _roundLockAt[roundId];
        if (lockAt == 0 || block.timestamp < uint256(lockAt)) return false;
        return marketRoundStateByRound[roundId][triggerMarketId].totals.betCount > 0;
    }

    /// @dev `roundStorage` arrays are empty unless the round has at least one bet on some market (see `_resolveOpenRound`).
    function _roundFirstMarket(uint64 roundId) private view returns (uint32 m0) {
        uint32[] storage rm = _roundMarkets[roundId];
        if (rm.length == 0) return 0;
        return rm[0];
    }

    /// @notice Parallel payout shards: each lane prefers indices `lane, lane+laneCount, ...`. Jackpot batches use shard index `type(uint32).max` on `markets[0]` (lane `0` only).
    function _findParallelPayoutWork(
        uint32 totalMarkets,
        uint32 lane,
        uint32 width,
        uint32 scanBudget
    ) private view returns (bool found, Job memory job) {
        uint32 laneCount = payoutParallelLaneCount;
        unchecked {
            (uint64 ridStart, uint32 midScanStart) = _payoutFinderScanStarts(totalMarkets);

            for (uint64 rid = ridStart; rid <= _globalRound; ++rid) {
                GlobalRoundState storage gr = globalRoundState[rid];
                if (!gr.vrfFulfilled) continue;

                uint32 m0 = _roundFirstMarket(rid);

                if (m0 != 0 && gr.jackpotTriggered && !gr.jackpotDistributed && lane == 0) {
                    MarketRoundState storage mr0 = marketRoundStateByRound[rid][m0];
                    if (!mr0.settled && mr0.totals.betCount > 0) {
                        if (scanBudget == 0) return (false, job);
                        scanBudget--;
                        return (true, Job({
                            kind: JobKind.Payout,
                            marketId: m0,
                            roundId: rid,
                            nextCursor: 0,
                            payoutShardIndex: PAYOUT_SHARD_JACKPOT,
                            payoutShardWidth: width
                        }));
                    }
                }

                uint32 mid0 = rid == ridStart ? midScanStart : uint32(1);
                for (uint32 mid = mid0; mid <= totalMarkets; ++mid) {
                    if (scanBudget == 0) return (false, job);
                    scanBudget--;

                    MarketRoundState storage mr = marketRoundStateByRound[rid][mid];
                    if (mr.settled || mr.totals.betCount == 0) continue;

                    if (gr.jackpotTriggered && !gr.jackpotDistributed && mid == m0) continue;

                    uint256 winners = mr.winningBetCount;
                    if (winners == 0) {
                        if (lane != 0) continue;
                        return (true, Job({
                            kind: JobKind.Payout,
                            marketId: mid,
                            roundId: rid,
                            nextCursor: 0,
                            payoutShardIndex: 0,
                            payoutShardWidth: width
                        }));
                    }

                    uint256 shardCount = (winners + uint256(width) - 1) / uint256(width);
                    if (shardCount > MAX_PARALLEL_PAYOUT_SHARDS) continue;

                    uint256 doneMask = payoutShardsDone[rid][mid];
                    for (uint256 si = lane; si < shardCount; si += uint256(laneCount)) {
                        if ((doneMask >> si) & 1 == 0) {
                            return (true, Job({
                                kind: JobKind.Payout,
                                marketId: mid,
                                roundId: rid,
                                nextCursor: 0,
                                payoutShardIndex: uint32(si),
                                payoutShardWidth: width
                            }));
                        }
                    }
                }
            }
        }
        return (false, job);
    }

    function executeJob(
        Job memory job,
        uint32 maxPayoutsPerCall,
        IBankVault.Payout[] memory winnerPayoutRows
    ) external onlyScheduler returns (bool) {
        if (winnerPayoutRows.length != 0) {
            if (job.kind != JobKind.Payout) revert UnexpectedWinnerAttachment();
        }
        if (job.kind == JobKind.OpenRound) {
            _openNextRound();
            return true;
        }
        if (job.kind == JobKind.PreLock) {
            _sealGlobalRound();
            return true;
        }
        if (job.kind == JobKind.TriggerVrf) {
            _triggerVrf();
            return true;
        }
        if (job.kind == JobKind.Payout) {
            uint256 L = payoutParallelLaneCount;
            if (L > 1 && job.payoutShardWidth != 0) {
                if (job.payoutShardIndex == PAYOUT_SHARD_JACKPOT) {
                    _processJackpotOnlyStep(job.roundId, job.marketId, maxPayoutsPerCall);
                } else {
                    _processPayoutShard(
                        job.roundId,
                        job.marketId,
                        job.payoutShardIndex,
                        job.payoutShardWidth,
                        maxPayoutsPerCall,
                        winnerPayoutRows
                    );
                }
            } else {
                if (job.payoutShardIndex != 0 || job.payoutShardWidth != 0) revert InvalidJob();
                _processPayout(job.roundId, job.marketId, maxPayoutsPerCall, winnerPayoutRows);
            }
            return true;
        }
        revert InvalidJob();
    }

    /// @inheritdoc IRouletteEngine
    function previewWinnerPayoutBundle(Job memory job, uint32 maxPayoutsPerCall)
        external
        view
        returns (IBankVault.Payout[] memory payouts)
    {
        IBankVault.Payout[] memory empty;
        (bool ok, uint64 rid, uint32 mid, uint256 start, uint256 chunk, uint8 wn) =
            _winnerPayoutWindow(job, maxPayoutsPerCall);
        if (!ok) {
            return empty;
        }
        (payouts,,,) = _previewWinningPayoutsSlice(rid, mid, wn, start, chunk, chunk);
    }

    function currentGlobalRound() external view returns (uint64) { return _globalRound; }
    function hasPendingVrf() external view returns (bool) { return _pendingRequestId != 0; }
    function vrfActiveRound() external view returns (uint64) { return _activeVrfRound; }
    function vrfActiveMarket() external pure returns (uint32) { return 0; }
    function jackpotPool() external view returns (uint256) {
        return JACKPOT_TREASURY.jackpotPool();
    }

    function pushPayouts(uint32 marketId, uint64, IBankVault.Payout[] calldata payouts) external onlyRole(ENGINE_ADMIN_ROLE) {
        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        IBankVault(cfg.bank).payoutBatch(payouts);
    }

    function _resolveOpenRound(uint32 marketId) private returns (uint64 roundId) {
        roundId = _globalRound;
        if (roundId == 0 || roundPhase[roundId] != RoundPhase.Open) revert NoOpenRound();
        if (!_roundHasMarket[roundId][marketId]) {
            _roundHasMarket[roundId][marketId] = true;
            _roundMarkets[roundId].push(marketId);
            unchecked {
                ++_roundMarketParticipantCount[roundId];
            }
        }
    }

    function _openNextRound() private {
        if (_globalRound != 0 && roundPhase[_globalRound] == RoundPhase.Open) revert InvalidRound();
        uint256 cleanedId;
        unchecked {
            cleanedId = _globalRound;
            ++_globalRound;
        }
        if (roundPhase[_globalRound] != RoundPhase.Unset) revert InvalidRound();
        roundPhase[_globalRound] = RoundPhase.Open;
        emit RoundCleaningCompleted(
            cleanedId,
            uint256(_globalRound),
            block.timestamp,
            LegacyFees({ protocolFees: 0, burnAmount: 0, jackpotAmount: 0 })
        );
    }

    // Pre-VRF lock step: freezes the current global round.
    function _sealGlobalRound() private {
        uint64 roundId = _globalRound;
        if (roundId == 0 || roundPhase[roundId] != RoundPhase.Open) revert InvalidRound();
        uint32 triggerMarketId = _roundTriggerMarket[roundId];
        if (triggerMarketId == 0) revert InvalidRound();
        if (block.timestamp < uint256(_roundLockAt[roundId])) revert InvalidRound();
        if (marketRoundStateByRound[roundId][triggerMarketId].totals.betCount == 0) revert NoBets();

        emit RoundLocked(triggerMarketId, roundId, roundId);
        roundPhase[roundId] = RoundPhase.Locked;
        emit GlobalRoundSealed(roundId, triggerMarketId);
        emit BettingWindowClosed(uint256(roundId));
        _vrfQueue.push(roundId);
    }

    function _triggerVrf() private {
        if (_pendingRequestId != 0) revert VrfAlreadyPending();
        if (_vrfQueueHead >= _vrfQueue.length) revert InvalidRound();

        uint64 roundId = _vrfQueue[_vrfQueueHead];
        if (roundPhase[roundId] != RoundPhase.Locked) revert InvalidRound();
        globalRoundState[roundId].vrfRequested = true;
        roundPhase[roundId] = RoundPhase.Settling;
        _activeVrfRound = roundId;

        uint256 req = VRF_COORDINATOR.requestRandomWords(
            VRF_KEY_HASH,
            uint64(VRF_SUBSCRIPTION_ID),
            VRF_CONFIRMATIONS,
            VRF_CALLBACK_GAS_LIMIT,
            2
        );
        _pendingRequestId = req;
        requestIdToGlobalRound[req] = roundId;
        emit VrfRequested(uint256(roundId), req, block.timestamp);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        uint64 roundId = requestIdToGlobalRound[requestId];
        if (roundId == 0) revert InvalidRound();

        GlobalRoundState storage gr = globalRoundState[roundId];
        gr.vrfFulfilled = true;
        gr.randomWord = randomWords[0];
        uint256 modWin = randomWords[0] % 37;
        uint8 winningNumber = uint8(modWin);
        gr.winningNumber = winningNumber;
        _snapshotRoundMarketWinningCounts(roundId, winningNumber);

        uint256 modJp = randomWords[1] % 37;
        if (modWin == modJp) {
            gr.jackpotTriggered = true;
        }

        _pendingRequestId = 0;
        _activeVrfRound = 0;
        _vrfQueueHead += 1;

        emit VRFResult(uint256(roundId), uint256(winningNumber), modJp);

        if (_payoutFinderRound == 0 || roundId < _payoutFinderRound) {
            _payoutFinderRound = roundId;
            _payoutFinderMarket = 1;
        }

        uint256 totalWinningBets = _sumRoundWinningBetCounts(roundId);
        if (gr.jackpotTriggered) {
            uint256 jackpotWinners = _countJackpotEligibleWinners(roundId, winningNumber);
            if (jackpotWinners > 0) {
                emit JackpotResultEvent(uint256(roundId), jackpotWinners);
            }
        }
        if (totalWinningBets > 0) {
            emit ComputedPayouts(uint256(roundId), totalWinningBets);
        }
    }

    function _processPayout(
        uint64 roundId,
        uint32 marketId,
        uint32 maxPayoutsPerCall,
        IBankVault.Payout[] memory winnerPayoutRows
    ) private {
        if (maxPayoutsPerCall == 0) revert InvalidJob();
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.vrfFulfilled) revert InvalidRound();

        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
        if (mr.settled) return;

        address bank = REGISTRY.getMarket(marketId).bank;

        if (!mr.betsReleased) {
            IBankVault(bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }
        _executeJackpotBatch(roundId, marketId, maxPayoutsPerCall);

        if (gr.jackpotTriggered && !gr.jackpotDistributed && marketId == _roundFirstMarket(roundId)) {
            // Stale Automation bundles may attach rows; ignore — winner payouts are deferred until jackpot completes.
            return;
        }

        uint256 totalWinners = mr.winningBetCount;
        uint256 start = mr.payoutCursor;
        if (start >= totalWinners && totalWinners > 0) revert InvalidRound();

        if (totalWinners == 0) {
            // No winning bet rows; ignore any pre-built payout rows from `checkUpkeep` / `performUpkeep` skew.
            _collectMarketFees(roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
            mr.settled = true;
            unchecked {
                ++_roundMarketsSettledCount[roundId];
            }
            IBankVault(bank).processWithdrawalQueue(withdrawalQueueBatchSize);
            emit PayoutProgress(roundId, marketId, 0, 0, 0);
            _advancePayoutFinderHintAfterSettlement(roundId, marketId);
            _tryCompleteGlobalRound(roundId);
            return;
        }

        uint256 chunk = totalWinners - start > uint256(maxPayoutsPerCall)
            ? uint256(maxPayoutsPerCall)
            : totalWinners - start;
        uint256 end = start + chunk;

        (BatchResult memory result, uint256 newCursor) =
            _settleWinnerPayoutChunk(roundId, marketId, bank, gr.winningNumber, start, chunk, winnerPayoutRows);

        mr.payoutCursor = newCursor;
        mr.bankPaidRunning += result.bankPaid;
        emit PayoutProgress(roundId, marketId, uint32(start), uint32(end), result.bankPaid);

        if (newCursor >= totalWinners) {
            _collectMarketFees(roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
            mr.settled = true;
            unchecked {
                ++_roundMarketsSettledCount[roundId];
            }
            IBankVault(bank).processWithdrawalQueue(withdrawalQueueBatchSize);
            _advancePayoutFinderHintAfterSettlement(roundId, marketId);
            _tryCompleteGlobalRound(roundId);
        }
    }

    function _processJackpotOnlyStep(uint64 roundId, uint32 marketId, uint32 maxPayoutsPerCall) private {
        if (maxPayoutsPerCall == 0) revert InvalidJob();
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.vrfFulfilled) revert InvalidRound();
        uint32 m0 = _roundFirstMarket(roundId);
        if (m0 == 0 || marketId != m0) revert InvalidRound();

        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];

        if (!mr.betsReleased) {
            IBankVault(cfg.bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }
        _executeJackpotBatch(roundId, marketId, maxPayoutsPerCall);
    }

    function _processPayoutShard(
        uint64 roundId,
        uint32 marketId,
        uint32 shardIndex,
        uint32 shardWidthU,
        uint32 maxPayoutsPerCall,
        IBankVault.Payout[] memory winnerPayoutRows
    ) private {
        if (maxPayoutsPerCall == 0) revert InvalidJob();

        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.vrfFulfilled) revert InvalidRound();

        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
        address bank = REGISTRY.getMarket(marketId).bank;

        if (!mr.betsReleased) {
            IBankVault(bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }
        _executeJackpotBatch(roundId, marketId, maxPayoutsPerCall);

        if (gr.jackpotTriggered && !gr.jackpotDistributed && marketId == _roundFirstMarket(roundId)) {
            return;
        }

        _processPayoutShardAfterJackpot(roundId, marketId, shardIndex, uint256(shardWidthU), bank, mr, gr, winnerPayoutRows);
    }

    function _processPayoutShardAfterJackpot(
        uint64 roundId,
        uint32 marketId,
        uint32 shardIndex,
        uint256 shardW,
        address bank,
        MarketRoundState storage mr,
        GlobalRoundState storage gr,
        IBankVault.Payout[] memory winnerPayoutRows
    ) private {
        if (mr.settled) return;

        uint256 winners = mr.winningBetCount;
        if (winners == 0) {
            if (shardIndex != 0) revert InvalidJob();
            _processPayout(roundId, marketId, uint32(shardW), winnerPayoutRows);
            return;
        }

        uint256 shards = (winners + shardW - 1) / shardW;
        if (shards > MAX_PARALLEL_PAYOUT_SHARDS) revert TooManyPayoutShards();
        if (uint256(shardIndex) >= shards) revert InvalidJob();

        uint256 si = uint256(shardIndex);
        uint256 bits = payoutShardsDone[roundId][marketId];
        if ((bits >> si) & 1 != 0) return;

        uint256 start = si * shardW;
        uint256 chunk = winners - start > shardW ? shardW : winners - start;

        (BatchResult memory result, uint256 endPos) =
            _settleWinnerPayoutChunk(roundId, marketId, bank, gr.winningNumber, start, chunk, winnerPayoutRows);

        mr.bankPaidRunning += result.bankPaid;
        bits = payoutShardsDone[roundId][marketId] | (1 << si);
        payoutShardsDone[roundId][marketId] = bits;

        emit PayoutProgress(roundId, marketId, uint32(start), uint32(endPos), result.bankPaid);

        if (_allPayoutShardsDone(shards, bits)) {
            _finalizeMarketShardPayoutRound(roundId, marketId, bank, mr, winners);
        }
    }

    /// @dev Single mask check (`shards <= MAX_PARALLEL_PAYOUT_SHARDS`): cheaper than iterating up to ~256 shards.
    function _allPayoutShardsDone(uint256 shards, uint256 bits) private pure returns (bool) {
        if (shards == 0) return true;
        if (shards >= 256) {
            return bits == type(uint256).max;
        }
        unchecked {
            uint256 mask = (uint256(1) << shards) - 1;
            return bits & mask == mask;
        }
    }

    function _finalizeMarketShardPayoutRound(
        uint64 roundId,
        uint32 marketId,
        address bank,
        MarketRoundState storage mr,
        uint256 winners
    ) private {
        _collectMarketFees(roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
        mr.settled = true;
        unchecked {
            ++_roundMarketsSettledCount[roundId];
        }
        mr.payoutCursor = winners;
        IBankVault(bank).processWithdrawalQueue(withdrawalQueueBatchSize);
        _advancePayoutFinderHintAfterSettlement(roundId, marketId);
        _tryCompleteGlobalRound(roundId);
    }

    function _tryCompleteGlobalRound(uint64 rid) private {
        if (!_isRoundDone(rid)) return;
        roundPhase[rid] = RoundPhase.Completed;
        emit RoundResolved(uint256(rid));
    }

    function _collectMarketFees(uint64 roundId, uint32 marketId, address bank, uint256 totalBets, uint256 bankPaid) private {
        if (totalBets <= bankPaid) return;
        uint256 marketWin = totalBets - bankPaid;
        uint256 swapBps = JACKPOT_FUNDER.swapAssetTotalBps();
        uint256 swapIn = (marketWin * swapBps) / 10_000;
        if (swapIn > 0) {
            address asset = IERC4626(bank).asset();
            IBankVault(bank).transferOut(address(JACKPOT_FUNDER), swapIn);
            JACKPOT_FUNDER.fundFromMarket(marketId, asset, marketWin);
            emit JackpotFunded(roundId, marketId, swapIn);
        }
        uint256 infraFee = (marketWin * INFRA_BPS) / 10_000;
        if (infraFee > 0) {
            IBankVault(bank).transferOut(INFRA_RECIPIENT, infraFee);
            emit InfrastructureFeePaid(roundId, marketId, infraFee);
        }
    }

    function _executeJackpotBatch(uint64 roundId, uint32 marketId, uint32 maxPayoutsPerCall) private {
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (gr.jackpotDistributed || !gr.jackpotTriggered) return;
        if (maxPayoutsPerCall == 0) revert InvalidJob();

        uint32[] storage markets = _roundMarkets[roundId];
        if (markets.length == 0) return;
        if (marketId != markets[0]) return;

        uint8 winningNumber = gr.winningNumber;
        (address[] memory winners, uint256[] memory stakes, uint256 totalStake) =
            _collectJackpotEligibleStraightStakes(roundId, winningNumber);

        _executeJackpotBatchFromList(gr, roundId, marketId, winners, stakes, totalStake, maxPayoutsPerCall);
    }

    function _executeJackpotBatchFromList(
        GlobalRoundState storage gr,
        uint64,
        uint32,
        address[] memory winners,
        uint256[] memory stakes,
        uint256 totalStake,
        uint32 maxPayoutsPerCall
    ) private {
        uint256 n = winners.length;
        if (totalStake == 0 || n == 0) {
            gr.jackpotDistributed = true;
            return;
        }

        if (gr.jackpotPoolSnapshot == 0) {
            gr.jackpotPoolSnapshot = JACKPOT_TREASURY.jackpotPool();
            gr.jackpotTotalStake = totalStake;
            gr.jackpotWinnerCount = uint32(n);
        }

        _processJackpotChunk(gr, winners, stakes, maxPayoutsPerCall);
    }

    function _processJackpotChunk(
        GlobalRoundState storage gr,
        address[] memory winners,
        uint256[] memory stakes,
        uint32 maxPayoutsPerCall
    ) private {
        uint256 n = winners.length;
        uint256 pool0 = gr.jackpotPoolSnapshot;
        if (pool0 == 0) {
            gr.jackpotDistributed = true;
            return;
        }

        uint256 start = uint256(gr.jackpotCursor);
        if (start >= n) {
            gr.jackpotDistributed = true;
            return;
        }

        uint256 chunk = n - start > uint256(maxPayoutsPerCall) ? uint256(maxPayoutsPerCall) : n - start;
        JackpotComputeArgs memory args = JackpotComputeArgs({
            winners: winners,
            stakes: stakes,
            n: n,
            start: start,
            chunk: chunk,
            pool0: pool0,
            denom: gr.jackpotTotalStake,
            paidBefore: gr.jackpotPaid
        });

        (address[] memory wChunk, uint256[] memory aChunk,, uint256 end) = _computeJackpotBatch(args);
        uint256 paid = JACKPOT_TREASURY.payBatch(wChunk, aChunk);
        gr.jackpotPaid += paid;
        gr.jackpotCursor = uint32(end);
        if (end >= n) gr.jackpotDistributed = true;
    }

    function _computeJackpotBatch(JackpotComputeArgs memory a)
        private
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

    /// @dev Appends jackpot stake rows for one market straight bucket (lowers outer stack depth for solc IR).
    function _appendJackpotStraightStakesForMarket(
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        address[] memory winners,
        uint256[] memory stakes,
        uint256 out,
        uint256 totalStake
    ) private view returns (uint256 newOut, uint256 newTotalStake) {
        newOut = out;
        newTotalStake = totalStake;
        uint256 ratio = JACKPOT_FUNDER.brbPerAssetUnitRatio(marketId);
        BetEntry[] storage bucket2 =
            roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Straight)][winningNumber];
        uint256 len2 = bucket2.length;
        BetEntry storage b2;
        for (uint256 j; j < len2; ) {
            b2 = bucket2[j];
            uint256 a = uint256(b2.amount);
            if (a > minJackpotBet) {
                winners[newOut] = b2.player;
                uint256 stake = (a * ratio) / JACKPOT_RATIO_SCALE;
                stakes[newOut] = stake;
                newTotalStake += stake;
                unchecked {
                    ++newOut;
                }
            }
            unchecked {
                ++j;
            }
        }
    }

    /// @dev Collects eligible STRAIGHT stakes on `winningNumber` across all markets in the round.
    /// Stakes are normalized into BRB-equivalent units using `JACKPOT_FUNDER.brbPerAssetUnitRatio(marketId)`,
    /// so share computation is simply `stake / totalStake` even across mixed-decimal assets.
    function _collectJackpotEligibleStraightStakes(uint64 roundId, uint8 winningNumber)
        private
        view
        returns (address[] memory winners, uint256[] memory stakes, uint256 totalStake)
    {
        uint32[] storage markets = _roundMarkets[roundId];
        uint256 maxEntries;
        for (uint256 mi; mi < markets.length; ) {
            BetEntry[] storage bucket = roundNumberedBets[roundId][markets[mi]][uint8(NumberedBetBucket.Straight)][winningNumber];
            uint256 len = bucket.length;
            BetEntry storage b;
            for (uint256 i; i < len; ) {
                b = bucket[i];
                if (uint256(b.amount) > minJackpotBet) {
                    unchecked {
                        ++maxEntries;
                    }
                }
                unchecked {
                    ++i;
                }
            }
            unchecked {
                ++mi;
            }
        }

        winners = new address[](maxEntries);
        stakes = new uint256[](maxEntries);

        uint256 out;
        for (uint256 mi2; mi2 < markets.length; ) {
            (out, totalStake) = _appendJackpotStraightStakesForMarket(
                roundId, markets[mi2], winningNumber, winners, stakes, out, totalStake
            );
            unchecked {
                ++mi2;
            }
        }

        assembly ("memory-safe") {
            mstore(winners, out)
            mstore(stakes, out)
        }
    }

    function _snapshotRoundMarketWinningCounts(uint64 roundId, uint8 winningNumber) private {
        uint32[] storage markets = _roundMarkets[roundId];
        for (uint256 mi; mi < markets.length; ) {
            uint32 mid = markets[mi];
            MarketRoundState storage mr = marketRoundStateByRound[roundId][mid];
            if (mr.totals.betCount > 0) {
                RouletteBetLib.WinningBetTypes memory wt = RouletteBetLib.getWinningBetTypes(winningNumber);
                mr.winningBetCount = _countMarketWinningBets(roundId, mid, winningNumber, wt);
                mr.payoutCursor = 0;
                mr.bankPaidRunning = 0;
            }
            unchecked {
                ++mi;
            }
        }
    }

    /// @notice Sum of `.length` on winning buckets only (ordering must match payout sweep below).
    function _countMarketWinningBets(
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        RouletteBetLib.WinningBetTypes memory wt
    ) private view returns (uint256 total) {
        unchecked {
            total +=
                roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Straight)][winningNumber].length;
            for (uint256 j; j < wt.winningSplits.length; ) {
                total += roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Split)][wt.winningSplits[j]].length;
                ++j;
            }
            if (wt.winningStreet != 0) {
                total += roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Street)][wt.winningStreet].length;
            }
            for (uint256 j; j < wt.winningCorners.length; ) {
                total +=
                    roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Corner)][wt.winningCorners[j]].length;
                ++j;
            }
            for (uint256 j; j < wt.winningLines.length; ) {
                total += roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Line)][wt.winningLines[j]].length;
                ++j;
            }
            if (wt.winningColumn != 0) {
                total += roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Column)][wt.winningColumn].length;
            }
            if (wt.winningDozen != 0) {
                total += roundNumberedBets[roundId][marketId][uint8(NumberedBetBucket.Dozen)][wt.winningDozen].length;
            }
            if (wt.red) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Red)].length;
            if (wt.black) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Black)].length;
            if (wt.odd) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Odd)].length;
            if (wt.even) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Even)].length;
            if (wt.low) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Low)].length;
            if (wt.high) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.High)].length;
            if (wt.trio012) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Trio012)].length;
            if (wt.trio023) total += roundFlatBets[roundId][marketId][uint8(FlatBetBucket.Trio023)].length;
        }
    }

    /// @dev When winner payouts would be blocked because the market-0 jackpot path is still in flight.
    function _winnerPayoutWindow(Job memory job, uint32 maxPayoutsPerCall)
        private
        view
        returns (
            bool ok,
            uint64 roundId,
            uint32 marketId,
            uint256 start,
            uint256 chunk,
            uint8 winningNumber
        )
    {
        if (job.kind != JobKind.Payout || maxPayoutsPerCall == 0) {
            return (false, 0, 0, 0, 0, 0);
        }
        roundId = job.roundId;
        marketId = job.marketId;
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.vrfFulfilled) return (false, 0, 0, 0, 0, 0);
        if (job.payoutShardIndex == PAYOUT_SHARD_JACKPOT) return (false, 0, 0, 0, 0, 0);

        uint32 m0 = _roundFirstMarket(roundId);
        if (gr.jackpotTriggered && !gr.jackpotDistributed && marketId == m0) {
            return (false, 0, 0, 0, 0, 0);
        }

        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
        if (mr.settled) return (false, 0, 0, 0, 0, 0);

        winningNumber = gr.winningNumber;
        uint256 winners = mr.winningBetCount;

        uint256 L = payoutParallelLaneCount;
        bool parallelBranch = L > 1 && job.payoutShardWidth != 0;
        if (parallelBranch) {
            if (job.payoutShardWidth != maxPayoutsPerCall) return (false, 0, 0, 0, 0, 0);
            if (winners == 0) return (false, 0, 0, 0, 0, 0);

            uint256 shardW = uint256(job.payoutShardWidth);
            uint256 shards = (winners + shardW - 1) / shardW;
            if (shards > MAX_PARALLEL_PAYOUT_SHARDS) return (false, 0, 0, 0, 0, 0);

            uint256 si = uint256(job.payoutShardIndex);
            if (si >= shards) return (false, 0, 0, 0, 0, 0);

            uint256 bits = payoutShardsDone[roundId][marketId];
            if ((bits >> si) & 1 != 0) return (false, 0, 0, 0, 0, 0);

            start = si * shardW;
            chunk = winners - start > shardW ? shardW : winners - start;
        } else {
            if (job.payoutShardIndex != 0 || job.payoutShardWidth != 0) return (false, 0, 0, 0, 0, 0);
            if (winners == 0) return (false, 0, 0, 0, 0, 0);

            start = mr.payoutCursor;
            if (start >= winners) return (false, 0, 0, 0, 0, 0);

            chunk = winners - start > uint256(maxPayoutsPerCall)
                ? uint256(maxPayoutsPerCall)
                : winners - start;
        }

        ok = true;
    }

    /// @notice Flat winner stream traversal without vault transfers (`view` simulation / bundle building).
    function _previewWinningPayoutsSlice(
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint256 cursorStart,
        uint256 maxPayouts,
        uint256 batchCapacity
    ) private view returns (IBankVault.Payout[] memory out, uint256 written, uint256 nextCursor, uint256 bankPaidSum) {
        RouletteBetLib.WinningBetTypes memory wt = RouletteBetLib.getWinningBetTypes(winningNumber);
        out = new IBankVault.Payout[](batchCapacity);

        PayoutSweepCtx memory c;
        c.rid = roundId;
        c.mid = marketId;
        c.cursorStart = cursorStart;
        c.payoutMax = maxPayouts;
        c.gPos = 0;
        c.payoutCount = 0;
        c = _consumeWinningBucket(c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Straight)][winningNumber]);

        uint256 j;
        for (; c.payoutCount < c.payoutMax && j < wt.winningSplits.length;) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Split)][wt.winningSplits[j]]
            );
            unchecked {
                ++j;
            }
        }
        if (c.payoutCount < c.payoutMax && wt.winningStreet != 0) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Street)][wt.winningStreet]
            );
        }
        for (j = 0; c.payoutCount < c.payoutMax && j < wt.winningCorners.length;) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Corner)][wt.winningCorners[j]]
            );
            unchecked {
                ++j;
            }
        }
        for (j = 0; c.payoutCount < c.payoutMax && j < wt.winningLines.length;) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Line)][wt.winningLines[j]]
            );
            unchecked {
                ++j;
            }
        }
        if (c.payoutCount < c.payoutMax && wt.winningColumn != 0) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Column)][wt.winningColumn]
            );
        }
        if (c.payoutCount < c.payoutMax && wt.winningDozen != 0) {
            c = _consumeWinningBucket(
                c, out, roundNumberedBets[c.rid][c.mid][uint8(NumberedBetBucket.Dozen)][wt.winningDozen]
            );
        }
        if (c.payoutCount < c.payoutMax && wt.red) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Red)]);
        }
        if (c.payoutCount < c.payoutMax && wt.black) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Black)]);
        }
        if (c.payoutCount < c.payoutMax && wt.odd) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Odd)]);
        }
        if (c.payoutCount < c.payoutMax && wt.even) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Even)]);
        }
        if (c.payoutCount < c.payoutMax && wt.low) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Low)]);
        }
        if (c.payoutCount < c.payoutMax && wt.high) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.High)]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio012) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Trio012)]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio023) {
            c = _consumeWinningBucket(c, out, roundFlatBets[c.rid][c.mid][uint8(FlatBetBucket.Trio023)]);
        }

        written = c.payoutCount;
        assembly {
            mstore(out, written)
        }
        unchecked {
            for (uint256 i; i < written; ) {
                bankPaidSum += out[i].amount;
                ++i;
            }
            nextCursor = cursorStart + written;
        }
    }

    /// @notice Flat winner stream traversal: skips whole buckets cheaply until `cursorStart`; pays up to `maxPayouts` winners into one batch transfer.
    function _collectWinningPayoutsBatch(
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint256 cursorStart,
        uint256 maxPayouts,
        uint256 batchSize,
        address bank
    ) private returns (BatchResult memory result, uint256 nextCursor) {
        IBankVault.Payout[] memory out;
        uint256 written;
        (out, written, nextCursor,) = _previewWinningPayoutsSlice(roundId, marketId, winningNumber, cursorStart, maxPayouts, batchSize);

        result.payoutsCount = written;
        if (written > 0) {
            result.bankPaid = IBankVault(bank).payoutBatch(out);
        }

        unchecked {
            nextCursor = cursorStart + written;
        }
    }

    /// @dev Non-empty `prebuilt` rows come from Automation `checkUpkeep` (`previewWinnerPayoutBundle`).
    /// If state moved between check and perform, we ignore `prebuilt` and rebuild from storage so `performUpkeep` does not revert.
    function _settleWinnerPayoutChunk(
        uint64 roundId,
        uint32 marketId,
        address bank,
        uint8 winningNumber,
        uint256 start,
        uint256 chunk,
        IBankVault.Payout[] memory prebuilt
    ) private returns (BatchResult memory result, uint256 nextCursorPos) {
        uint256 len = prebuilt.length;
        if (len != 0) {
            if (len > chunk || !_prebuiltWinnerSliceMatchesStorage(roundId, marketId, winningNumber, start, chunk, prebuilt)) {
                len = 0;
            }
        }
        if (len != 0) {
            uint256 paid = IBankVault(bank).payoutBatch(prebuilt);
            result.bankPaid = paid;
            result.payoutsCount = len;
            nextCursorPos = start + len;
        } else {
            (result, nextCursorPos) = _collectWinningPayoutsBatch(
                roundId, marketId, winningNumber, start, chunk, chunk, bank
            );
        }
    }

    /// @notice Returns true iff `prebuilt` matches the canonical slice from `_previewWinningPayoutsSlice` (same `start`/`chunk`).
    function _prebuiltWinnerSliceMatchesStorage(
        uint64 roundId,
        uint32 marketId,
        uint8 winningNumber,
        uint256 start,
        uint256 chunk,
        IBankVault.Payout[] memory prebuilt
    ) private view returns (bool) {
        uint256 len = prebuilt.length;
        (IBankVault.Payout[] memory fresh, uint256 written,,) =
            _previewWinningPayoutsSlice(roundId, marketId, winningNumber, start, chunk, chunk);
        if (written != len) return false;
        unchecked {
            for (uint256 i; i < len; ++i) {
                if (fresh[i].player != prebuilt[i].player || fresh[i].amount != prebuilt[i].amount) {
                    return false;
                }
            }
        }
        return true;
    }

    function _sumRoundWinningBetCounts(uint64 roundId) private view returns (uint256 sum) {
        uint32[] storage markets = _roundMarkets[roundId];
        for (uint256 i; i < markets.length;) {
            sum += marketRoundStateByRound[roundId][markets[i]].winningBetCount;
            unchecked {
                ++i;
            }
        }
    }

    function _countJackpotEligibleWinners(uint64 roundId, uint8 winningNumber) private view returns (uint256 count) {
        uint32[] storage markets = _roundMarkets[roundId];
        for (uint256 mi; mi < markets.length;) {
            BetEntry[] storage bucket =
                roundNumberedBets[roundId][markets[mi]][uint8(NumberedBetBucket.Straight)][winningNumber];
            uint256 len = bucket.length;
            BetEntry storage b;
            for (uint256 j; j < len;) {
                b = bucket[j];
                if (uint256(b.amount) > minJackpotBet) {
                    unchecked {
                        ++count;
                    }
                }
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++mi;
            }
        }
    }

    function _consumeWinningBucket(PayoutSweepCtx memory c, IBankVault.Payout[] memory out, BetEntry[] storage bucket)
        private
        view
        returns (PayoutSweepCtx memory)
    {
        uint256 len = bucket.length;
        unchecked {
            if (c.gPos + len <= c.cursorStart) {
                c.gPos += len;
                return c;
            }
            BetEntry storage bet;
            for (uint256 i; i < len;) {
                uint256 gi = c.gPos + i;
                if (gi >= c.cursorStart && c.payoutCount < c.payoutMax) {
                    bet = bucket[i];
                    out[c.payoutCount] = IBankVault.Payout(bet.player, _payoutForBet(bet));
                    c.payoutCount++;
                }
                ++i;
            }
            c.gPos += len;
        }
        return c;
    }

    function _payoutFinderScanStarts(uint32 totalMarkets) private view returns (uint64 rStart, uint32 mStart) {
        uint64 gr = _globalRound;
        rStart = _payoutFinderRound;
        mStart = _payoutFinderMarket;
        if (totalMarkets == 0 || gr == 0) {
            return (1, 1);
        }
        if (rStart == 0 || rStart > gr) {
            rStart = 1;
            mStart = 1;
        }
        if (mStart == 0 || mStart > totalMarkets) {
            mStart = 1;
        }
    }

    function _advancePayoutFinderHintAfterSettlement(uint64 settledRound, uint32 settledMarket) private {
        if (_payoutFinderRound != settledRound || _payoutFinderMarket != settledMarket) {
            return;
        }
        uint32 tm = REGISTRY.marketCount();
        if (tm == 0) return;

        unchecked {
            uint64 nextR = settledRound;
            uint32 nextM = settledMarket + 1;
            if (nextM > tm) {
                nextM = 1;
                nextR = settledRound + 1;
            }
            uint64 gr = _globalRound;
            if (nextR > gr) {
                _payoutFinderRound = 1;
                _payoutFinderMarket = 1;
            } else {
                _payoutFinderRound = nextR;
                _payoutFinderMarket = nextM;
            }
        }
    }

    function _findFirstPayout(uint32 totalMarkets) private view returns (uint64, uint32) {
        uint64 gr = _globalRound;
        if (totalMarkets == 0 || gr == 0) {
            return (0, 0);
        }
        (uint64 roundStart, uint32 marketScanStart) = _payoutFinderScanStarts(totalMarkets);
        for (uint64 roundId = roundStart; roundId <= gr; ) {
            if (globalRoundState[roundId].vrfFulfilled) {
                uint32 m0 = (roundId == roundStart) ? marketScanStart : uint32(1);
                for (uint32 marketId = m0; marketId <= totalMarkets; ) {
                    MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
                    if (!mr.settled && mr.totals.betCount > 0) {
                        return (roundId, marketId);
                    }
                    unchecked {
                        ++marketId;
                    }
                }
            }
            unchecked {
                ++roundId;
            }
        }
        return (0, 0);
    }

    function _nextCursor(uint32 cursor, uint32 totalMarkets) private pure returns (uint32) {
        return cursor == totalMarkets ? 1 : cursor + 1;
    }

    function _isRoundDone(uint64 roundId) private view returns (bool) {
        uint32 n = _roundMarketParticipantCount[roundId];
        if (n == 0) return false;
        return _roundMarketsSettledCount[roundId] == n;
    }

    function _decodeAndValidateBet(bytes calldata betData) private pure returns (uint8 betType, uint16 number) {
        (uint256 t, uint256 n) = abi.decode(betData, (uint256, uint256));
        if (t == 0 || t > BET_TRIO_023) revert InvalidBetType();
        _validateBetNumber(t, n);
        betType = uint8(t);
        number = uint16(n);
    }

    function _routeBet(uint8 betType) private pure returns (bool isNumbered, uint8 bucket) {
        if (betType <= BET_DOZEN) return (true, betType - BET_STRAIGHT);
        if (betType >= BET_RED && betType <= BET_TRIO_023) return (false, betType - BET_RED);
        revert InvalidBetType();
    }

    function _validateBetNumber(uint256 betType, uint256 number) private pure {
        if (betType == BET_STRAIGHT) { if (number > 36) revert InvalidBetNumber(); return; }
        if (betType == BET_SPLIT) { if (!RouletteBetLib.isValidSplit(number)) revert InvalidBetNumber(); return; }
        if (betType == BET_STREET) { if (number == 0 || number > 34 || (number - 1) % 3 != 0) revert InvalidBetNumber(); return; }
        if (betType == BET_CORNER) { if (!RouletteBetLib.isValidCorner(number)) revert InvalidBetNumber(); return; }
        if (betType == BET_LINE) { if (number == 0 || number > 31 || (number - 1) % 3 != 0) revert InvalidBetNumber(); return; }
        if (betType == BET_COLUMN || betType == BET_DOZEN) { if (number == 0 || number > 3) revert InvalidBetNumber(); return; }
        if (number != 0) revert InvalidBetNumber();
    }

    function _payoutForBet(BetEntry storage bet) private view returns (uint256) {
        uint256 amount = uint256(bet.amount);
        if (bet.betType == BET_STRAIGHT) return amount * 36;
        if (bet.betType == BET_SPLIT) return amount * 18;
        if (bet.betType == BET_STREET) return amount * 12;
        if (bet.betType == BET_CORNER) return amount * 9;
        if (bet.betType == BET_LINE) return amount * 6;
        if (bet.betType == BET_COLUMN || bet.betType == BET_DOZEN) return amount * 3;
        if (bet.betType >= BET_RED && bet.betType <= BET_HIGH) return amount * 2;
        if (bet.betType == BET_TRIO_012 || bet.betType == BET_TRIO_023) return amount * 12;
        /* solcov ignore next */
        return 0;
    }

    function _accumulateWorstCaseExposure(uint64 rid, uint32 mid, uint8 betType, uint16 number, uint128 amt128)
        private
    {
        uint256 amount = uint256(amt128);
        unchecked {
            if (betType == BET_STRAIGHT) {
                uint256 row = roundStraightBetsSum[rid][mid][number];
                if (row > roundMaxStraightBet[rid][mid]) {
                    roundMaxStraightBet[rid][mid] = row;
                }
                return;
            }
            if (betType == BET_STREET) {
                uint256 t = roundStreetBetsTotal[rid][mid][number] + amount;
                roundStreetBetsTotal[rid][mid][number] = t;
                if (t > roundMaxStreetBet[rid][mid]) {
                    roundMaxStreetBet[rid][mid] = t;
                }
                return;
            }
            if (betType == BET_SPLIT) {
                roundOtherBetsWeightedPayout[rid][mid] += amount * 18;
                return;
            }
            if (betType == BET_CORNER) {
                roundOtherBetsWeightedPayout[rid][mid] += amount * 9;
                return;
            }
            if (betType == BET_LINE) {
                roundOtherBetsWeightedPayout[rid][mid] += amount * 6;
                return;
            }
            if (betType == BET_COLUMN) {
                roundColumnBetsSum[rid][mid][number] += amount;
                return;
            }
            if (betType == BET_DOZEN) {
                roundDozenBetsSum[rid][mid][number] += amount;
                return;
            }
            if (betType == BET_RED) {
                roundRedBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_BLACK) {
                roundBlackBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_ODD) {
                roundOddBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_EVEN) {
                roundEvenBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_LOW) {
                roundLowBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_HIGH) {
                roundHighBetsSum[rid][mid] += amount;
                return;
            }
            if (betType == BET_TRIO_012 || betType == BET_TRIO_023) {
                roundOtherBetsWeightedPayout[rid][mid] += amount * 12;
            }
        }
    }

    function _bufferedMarketMaxLiability(uint64 rid, uint32 mid) private view returns (uint256) {
        uint256 raw = _rawStraightStreetLiability(rid, mid) + _rawOutsidePairLiability(rid, mid) + _rawDozenColumnLiability(rid, mid)
            + roundOtherBetsWeightedPayout[rid][mid];
        return RouletteLib.applySafetyBuffer(raw);
    }

    function _rawStraightStreetLiability(uint64 rid, uint32 mid) private view returns (uint256) {
        unchecked {
            return roundMaxStraightBet[rid][mid] * 36 + roundMaxStreetBet[rid][mid] * 12;
        }
    }

    function _rawOutsidePairLiability(uint64 rid, uint32 mid) private view returns (uint256) {
        unchecked {
            uint256 rb = RouletteLib.max(roundRedBetsSum[rid][mid], roundBlackBetsSum[rid][mid]) * 2;
            uint256 oe = RouletteLib.max(roundOddBetsSum[rid][mid], roundEvenBetsSum[rid][mid]) * 2;
            uint256 lh = RouletteLib.max(roundLowBetsSum[rid][mid], roundHighBetsSum[rid][mid]) * 2;
            return rb + oe + lh;
        }
    }

    function _rawDozenColumnLiability(uint64 rid, uint32 mid) private view returns (uint256) {
        unchecked {
            uint256 d1 = roundDozenBetsSum[rid][mid][1];
            uint256 d2 = roundDozenBetsSum[rid][mid][2];
            uint256 d3 = roundDozenBetsSum[rid][mid][3];
            uint256 c1 = roundColumnBetsSum[rid][mid][1];
            uint256 c2 = roundColumnBetsSum[rid][mid][2];
            uint256 c3 = roundColumnBetsSum[rid][mid][3];
            return RouletteLib.max3(d1, d2, d3) * 3 + RouletteLib.max3(c1, c2, c3) * 3;
        }
    }

}
