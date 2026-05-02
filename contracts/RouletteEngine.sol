// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { VRFCoordinatorV2Interface } from "@chainlink/contracts/src/v0.8/vrf/interfaces/VRFCoordinatorV2Interface.sol";
import { VRFConsumerBaseV2 } from "./external/VRFConsumerBaseV2.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { IJackpotTreasury } from "./interfaces/IJackpotTreasury.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { BetStorageLib } from "./libraries/BetStorageLib.sol";
import { RouletteBetLib } from "./libraries/RouletteBetLib.sol";

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
    uint256 private constant JACKPOT_BPS = 250;
    uint256 private constant INFRA_BPS = 250;

    struct BetEntry {
        address player;
        uint128 amount;
        uint8 betType;
        uint16 number;
    }

    struct MarketState {
        bool registered;
    }

    struct GlobalRoundState {
        bool vrfRequested;
        bool vrfFulfilled;
        uint256 randomWord;
        uint8 winningNumber;
        bool jackpotTriggered;
        /// @dev 0 if no eligible winner (no qualifying bets on jackpot number).
        uint32 jackpotWinnerMarketId;
        uint256 jackpotWinnerBetIndex;
        bool jackpotDistributed;
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

    IMarketRegistry public immutable REGISTRY;
    IJackpotTreasury public immutable JACKPOT_TREASURY;
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

    address public immutable INFRA_RECIPIENT;

    mapping(uint32 => address) public marketBank;
    mapping(uint32 => MarketState) public marketState;
    mapping(uint64 => GlobalRoundState) public globalRoundState;
    mapping(uint64 => mapping(uint32 => MarketRoundState)) public marketRoundStateByRound;
    /// @notice Bets with stake > minJackpotBet at record time.
    mapping(uint64 => mapping(uint32 => BetEntry[])) private _jackpotEligibleBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => uint256))) public roundStraightBetsSum;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundStraightBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundSplitBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundStreetBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundCornerBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundLineBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundColumnBets;
    mapping(uint64 => mapping(uint32 => mapping(uint256 => BetEntry[]))) private roundDozenBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundRedBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundBlackBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundOddBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundEvenBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundLowBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundHighBets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundTrio012Bets;
    mapping(uint64 => mapping(uint32 => BetEntry[])) private roundTrio023Bets;
    mapping(uint64 => uint32[]) private _roundMarkets;
    mapping(uint64 => mapping(uint32 => bool)) private _roundHasMarket;
    mapping(uint64 => uint32) private _roundTriggerMarket;
    mapping(uint64 => uint40) private _roundLockAt;
    bool private _hasPreviousWinningNumber;
    uint8 private _previousWinningNumber;
    mapping(uint64 => RoundPhase) public roundPhase;
    mapping(uint256 => uint64) public requestIdToGlobalRound;

    error UnauthorizedScheduler();
    error UnauthorizedBank();
    error InvalidMarket();
    error MarketDisabled();
    error RoundIsLocked();
    error NoBets();
    error VrfAlreadyPending();
    error InvalidJob();
    error InvalidRound();
    error ZeroAddress();
    error InvalidBetType();
    error InvalidBetNumber();
    error InvalidRoundDuration();

    event SchedulerRegistered(address scheduler, bool allowed);
    event MarketRegistered(uint32 marketId, address bank);
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
    event VrfRequested(uint256 requestId, uint64 globalRoundId);
    event VrfFulfilled(uint64 globalRoundId, uint256 randomWord);
    event PayoutProgress(uint64 globalRoundId, uint32 marketId, uint32 fromCursor, uint32 toCursor, uint256 paidAmount);
    event RoundPayoutCompleted(uint64 globalRoundId);
    event JackpotFunded(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event InfrastructureFeePaid(uint64 globalRoundId, uint32 marketId, uint256 amount);
    event MinJackpotBetUpdated(uint256 previousMin, uint256 newMin);

    modifier onlyScheduler() {
        if (!hasRole(SCHEDULER_ROLE, msg.sender)) revert UnauthorizedScheduler();
        _;
    }

    modifier onlyBank(uint32 marketId) {
        if (marketBank[marketId] != msg.sender) revert UnauthorizedBank();
        _;
    }

    constructor(
        address registry,
        address jackpotTreasury,
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
            registry == address(0) || jackpotTreasury == address(0) || infraRecipient == address(0)
                || vrfCoordinator == address(0) || admin == address(0)
        ) revert ZeroAddress();
        if (roundDuration == 0) revert InvalidRoundDuration();
        REGISTRY = IMarketRegistry(registry);
        JACKPOT_TREASURY = IJackpotTreasury(jackpotTreasury);
        INFRA_RECIPIENT = infraRecipient;
        VRF_COORDINATOR = VRFCoordinatorV2Interface(vrfCoordinator);
        VRF_SUBSCRIPTION_ID = subscriptionId;
        VRF_KEY_HASH = keyHash;
        VRF_CALLBACK_GAS_LIMIT = callbackGasLimit;
        VRF_CONFIRMATIONS = confirmations;
        ROUND_DURATION = roundDuration;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ENGINE_ADMIN_ROLE, admin);
    }

    function registerScheduler(address scheduler, bool allowed) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (scheduler == address(0)) revert ZeroAddress();
        if (allowed) _grantRole(SCHEDULER_ROLE, scheduler);
        else _revokeRole(SCHEDULER_ROLE, scheduler);
        emit SchedulerRegistered(scheduler, allowed);
    }

    function setMinJackpotBet(uint256 newMinJackpotBet) external onlyRole(ENGINE_ADMIN_ROLE) {
        uint256 previous = minJackpotBet;
        minJackpotBet = newMinJackpotBet;
        emit MinJackpotBetUpdated(previous, newMinJackpotBet);
    }

    function registerMarket(uint32 marketId, address bank) external onlyRole(ENGINE_ADMIN_ROLE) {
        if (bank == address(0)) revert ZeroAddress();
        IMarketRegistry.MarketConfig memory cfg = REGISTRY.getMarket(marketId);
        if (!cfg.enabled) revert MarketDisabled();
        marketBank[marketId] = bank;
        JACKPOT_TREASURY.registerMarket(marketId, IERC4626(bank).asset());
        MarketState storage st = marketState[marketId];
        st.registered = true;
        emit MarketRegistered(marketId, bank);
    }

    function recordBet(uint32 marketId, address player, uint256 amount, bytes calldata betData) external onlyBank(marketId) {
        MarketState storage st = marketState[marketId];
        if (!st.registered) revert InvalidMarket();

        uint64 roundId = _resolveOpenRound(marketId);
        if (roundPhase[roundId] != RoundPhase.Open) revert RoundIsLocked();
        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
        if (mr.totals.betCount == 0) {
            if (_roundTriggerMarket[roundId] == 0) {
                _roundTriggerMarket[roundId] = marketId;
                _roundLockAt[roundId] = uint40(block.timestamp + uint256(ROUND_DURATION));
            }
        }

        (uint8 betType, uint16 number) = _decodeAndValidateBet(betData);
        BetEntry memory bet = BetEntry(player, uint128(amount), betType, number);
        if (amount > minJackpotBet) {
            _jackpotEligibleBets[roundId][marketId].push(bet);
        }

        if (betType == BET_STRAIGHT) {
            roundStraightBets[roundId][marketId][number].push(bet);
            roundStraightBetsSum[roundId][marketId][number] += amount;
        }

        if (betType == BET_SPLIT) roundSplitBets[roundId][marketId][number].push(bet);
        else if (betType == BET_STREET) roundStreetBets[roundId][marketId][number].push(bet);
        else if (betType == BET_CORNER) roundCornerBets[roundId][marketId][number].push(bet);
        else if (betType == BET_LINE) roundLineBets[roundId][marketId][number].push(bet);
        else if (betType == BET_COLUMN) roundColumnBets[roundId][marketId][number].push(bet);
        else if (betType == BET_DOZEN) roundDozenBets[roundId][marketId][number].push(bet);
        else if (betType == BET_RED) roundRedBets[roundId][marketId].push(bet);
        else if (betType == BET_BLACK) roundBlackBets[roundId][marketId].push(bet);
        else if (betType == BET_ODD) roundOddBets[roundId][marketId].push(bet);
        else if (betType == BET_EVEN) roundEvenBets[roundId][marketId].push(bet);
        else if (betType == BET_LOW) roundLowBets[roundId][marketId].push(bet);
        else if (betType == BET_HIGH) roundHighBets[roundId][marketId].push(bet);
        else if (betType == BET_TRIO_012) roundTrio012Bets[roundId][marketId].push(bet);
        else if (betType == BET_TRIO_023) {
            roundTrio023Bets[roundId][marketId].push(bet);
        }
        mr.totals.addBet(amount);
        emit BetRecorded(marketId, roundId, player, amount, betType, number);
    }

    function findNextJob(uint32 startCursor, uint32) external view returns (bool found, Job memory job) {
        uint32 totalMarkets = REGISTRY.marketCount();
        if (totalMarkets == 0) return (false, job);

        (uint64 payoutRound, uint32 payoutMarket) = _findFirstPayout(totalMarkets);
        if (payoutRound != 0) return (true, Job(JobKind.Payout, payoutMarket, payoutRound, startCursor));

        if (_pendingRequestId == 0 && _vrfQueueHead < _vrfQueue.length) {
            return (true, Job(JobKind.TriggerVrf, 0, _vrfQueue[_vrfQueueHead], startCursor));
        }

        uint64 roundId = _globalRound;
        if (roundId != 0 && roundPhase[roundId] == RoundPhase.Open) {
            uint32 triggerMarketId = _roundTriggerMarket[roundId];
            if (
                triggerMarketId != 0 && block.timestamp >= uint256(_roundLockAt[roundId])
                    && marketRoundStateByRound[roundId][triggerMarketId].totals.betCount > 0
            ) {
                return (true, Job(JobKind.PreLock, 0, roundId, startCursor));
            }
        }
        return (false, job);
    }

    function executeJob(Job memory job, uint32 maxPayoutsPerCall) external onlyScheduler returns (bool) {
        if (job.kind == JobKind.PreLock) {
            _sealGlobalRound();
            return true;
        }
        if (job.kind == JobKind.TriggerVrf) {
            _triggerVrf();
            return true;
        }
        if (job.kind == JobKind.Payout) {
            _processPayout(job.roundId, job.marketId, maxPayoutsPerCall);
            return true;
        }
        revert InvalidJob();
    }

    function currentGlobalRound() external view returns (uint64) { return _globalRound; }
    function hasPendingVrf() external view returns (bool) { return _pendingRequestId != 0; }
    function vrfActiveRound() external view returns (uint64) { return _activeVrfRound; }
    function vrfActiveMarket() external pure returns (uint32) { return 0; }
    function jackpotPool() external view returns (uint256) {
        return JACKPOT_TREASURY.jackpotPool();
    }

    function pushPayouts(uint32 marketId, uint64, IBankVault.Payout[] calldata payouts) external onlyRole(ENGINE_ADMIN_ROLE) {
        IBankVault(marketBank[marketId]).payoutBatch(payouts);
    }

    function _resolveOpenRound(uint32 marketId) private returns (uint64 roundId) {
        if (_globalRound == 0 || roundPhase[_globalRound] != RoundPhase.Open) ++_globalRound;
        roundId = _globalRound;
        if (!_roundHasMarket[roundId][marketId]) {
            _roundHasMarket[roundId][marketId] = true;
            _roundMarkets[roundId].push(marketId);
        }
        if (roundPhase[roundId] == RoundPhase.Unset) roundPhase[roundId] = RoundPhase.Open;
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
        emit VrfRequested(req, roundId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        uint64 roundId = requestIdToGlobalRound[requestId];
        if (roundId == 0) revert InvalidRound();

        GlobalRoundState storage gr = globalRoundState[roundId];
        gr.vrfFulfilled = true;
        gr.randomWord = randomWords[0];
        uint8 winningNumber = uint8(randomWords[0] % 37);
        gr.winningNumber = winningNumber;
        _snapshotRoundMarketWinningCounts(roundId, winningNumber);

        if (_hasPreviousWinningNumber && _previousWinningNumber == winningNumber) {
            gr.jackpotTriggered = true;
            (uint32 winnerMarketId, uint256 winnerBetIndex) =
                _resolveJackpotWinner(roundId, winningNumber, randomWords[1]);
            if (winnerMarketId != 0) {
                gr.jackpotWinnerMarketId = winnerMarketId;
                gr.jackpotWinnerBetIndex = winnerBetIndex;
            }
        }
        _hasPreviousWinningNumber = true;
        _previousWinningNumber = winningNumber;

        _pendingRequestId = 0;
        _activeVrfRound = 0;
        _vrfQueueHead += 1;

        emit VrfFulfilled(roundId, randomWords[0]);
    }

    function _processPayout(uint64 roundId, uint32 marketId, uint32 maxPayoutsPerCall) private {
        if (maxPayoutsPerCall == 0) revert InvalidJob();
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.vrfFulfilled) revert InvalidRound();

        address bank = marketBank[marketId];
        if (bank == address(0)) revert InvalidMarket();
        MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];

        if (!mr.betsReleased) {
            IBankVault(bank).releaseBets(mr.totals.totalAmount);
            mr.betsReleased = true;
        }
        _executeJackpotBatch(roundId, marketId);
        if (mr.settled) revert InvalidRound();

        uint256 totalWinners = mr.winningBetCount;
        uint256 start = mr.payoutCursor;
        if (start >= totalWinners && totalWinners > 0) revert InvalidRound();

        if (totalWinners == 0) {
            _collectMarketFees(roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
            mr.settled = true;
            emit PayoutProgress(roundId, marketId, 0, 0, 0);
            if (_isRoundDone(roundId)) {
                roundPhase[roundId] = RoundPhase.Completed;
                emit RoundPayoutCompleted(roundId);
            }
            return;
        }

        uint256 chunk = totalWinners - start > uint256(maxPayoutsPerCall)
            ? uint256(maxPayoutsPerCall)
            : totalWinners - start;
        uint256 end = start + chunk;

        (BatchResult memory result, uint256 newCursor) =
            _collectWinningPayoutsBatch(roundId, marketId, gr.winningNumber, start, chunk, chunk, bank);

        mr.payoutCursor = newCursor;
        mr.bankPaidRunning += result.bankPaid;
        emit PayoutProgress(roundId, marketId, uint32(start), uint32(end), result.bankPaid);

        if (newCursor >= totalWinners) {
            _collectMarketFees(roundId, marketId, bank, mr.totals.totalAmount, mr.bankPaidRunning);
            mr.settled = true;
            if (_isRoundDone(roundId)) {
                roundPhase[roundId] = RoundPhase.Completed;
                emit RoundPayoutCompleted(roundId);
            }
        }
    }

    function _collectMarketFees(uint64 roundId, uint32 marketId, address bank, uint256 totalBets, uint256 bankPaid) private {
        if (totalBets <= bankPaid) return;
        uint256 marketWin = totalBets - bankPaid;
        uint256 jackpotFee = (marketWin * JACKPOT_BPS) / 10_000;
        uint256 infraFee = (marketWin * INFRA_BPS) / 10_000;

        if (jackpotFee > 0) {
            IBankVault(bank).transferOut(address(JACKPOT_TREASURY), jackpotFee);
            emit JackpotFunded(roundId, marketId, jackpotFee);
        }
        if (infraFee > 0) {
            IBankVault(bank).transferOut(INFRA_RECIPIENT, infraFee);
            emit InfrastructureFeePaid(roundId, marketId, infraFee);
        }
    }

    function _executeJackpotBatch(uint64 roundId, uint32 marketId) private {
        GlobalRoundState storage gr = globalRoundState[roundId];
        if (!gr.jackpotTriggered) return;
        if (gr.jackpotWinnerMarketId == 0 || gr.jackpotDistributed) return;
        if (marketId != gr.jackpotWinnerMarketId) return;
        BetEntry storage winBet = _jackpotEligibleBets[roundId][marketId][gr.jackpotWinnerBetIndex];
        gr.jackpotDistributed = true;

        JACKPOT_TREASURY.payFullJackpot(winBet.player);
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
            total += roundStraightBets[roundId][marketId][winningNumber].length;
            for (uint256 j; j < wt.winningSplits.length; ) {
                total += roundSplitBets[roundId][marketId][wt.winningSplits[j]].length;
                ++j;
            }
            if (wt.winningStreet != 0) total += roundStreetBets[roundId][marketId][wt.winningStreet].length;
            for (uint256 j; j < wt.winningCorners.length; ) {
                total += roundCornerBets[roundId][marketId][wt.winningCorners[j]].length;
                ++j;
            }
            for (uint256 j; j < wt.winningLines.length; ) {
                total += roundLineBets[roundId][marketId][wt.winningLines[j]].length;
                ++j;
            }
            if (wt.winningColumn != 0) total += roundColumnBets[roundId][marketId][wt.winningColumn].length;
            if (wt.winningDozen != 0) total += roundDozenBets[roundId][marketId][wt.winningDozen].length;
            if (wt.red) total += roundRedBets[roundId][marketId].length;
            if (wt.black) total += roundBlackBets[roundId][marketId].length;
            if (wt.odd) total += roundOddBets[roundId][marketId].length;
            if (wt.even) total += roundEvenBets[roundId][marketId].length;
            if (wt.low) total += roundLowBets[roundId][marketId].length;
            if (wt.high) total += roundHighBets[roundId][marketId].length;
            if (wt.trio012) total += roundTrio012Bets[roundId][marketId].length;
            if (wt.trio023) total += roundTrio023Bets[roundId][marketId].length;
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
        RouletteBetLib.WinningBetTypes memory wt = RouletteBetLib.getWinningBetTypes(winningNumber);
        IBankVault.Payout[] memory out = new IBankVault.Payout[](batchSize);

        PayoutSweepCtx memory c;
        c.rid = roundId;
        c.mid = marketId;
        c.cursorStart = cursorStart;
        c.payoutMax = maxPayouts;
        c.gPos = 0;
        c.payoutCount = 0;
        c = _consumeWinningBucket(c, out, roundStraightBets[c.rid][c.mid][winningNumber]);

        uint256 j;
        for (; c.payoutCount < c.payoutMax && j < wt.winningSplits.length;) {
            c = _consumeWinningBucket(c, out, roundSplitBets[c.rid][c.mid][wt.winningSplits[j]]);
            unchecked {
                ++j;
            }
        }
        if (c.payoutCount < c.payoutMax && wt.winningStreet != 0) {
            c = _consumeWinningBucket(c, out, roundStreetBets[c.rid][c.mid][wt.winningStreet]);
        }
        for (j = 0; c.payoutCount < c.payoutMax && j < wt.winningCorners.length;) {
            c = _consumeWinningBucket(c, out, roundCornerBets[c.rid][c.mid][wt.winningCorners[j]]);
            unchecked {
                ++j;
            }
        }
        for (j = 0; c.payoutCount < c.payoutMax && j < wt.winningLines.length;) {
            c = _consumeWinningBucket(c, out, roundLineBets[c.rid][c.mid][wt.winningLines[j]]);
            unchecked {
                ++j;
            }
        }
        if (c.payoutCount < c.payoutMax && wt.winningColumn != 0) {
            c = _consumeWinningBucket(c, out, roundColumnBets[c.rid][c.mid][wt.winningColumn]);
        }
        if (c.payoutCount < c.payoutMax && wt.winningDozen != 0) {
            c = _consumeWinningBucket(c, out, roundDozenBets[c.rid][c.mid][wt.winningDozen]);
        }
        if (c.payoutCount < c.payoutMax && wt.red) {
            c = _consumeWinningBucket(c, out, roundRedBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.black) {
            c = _consumeWinningBucket(c, out, roundBlackBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.odd) {
            c = _consumeWinningBucket(c, out, roundOddBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.even) {
            c = _consumeWinningBucket(c, out, roundEvenBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.low) {
            c = _consumeWinningBucket(c, out, roundLowBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.high) {
            c = _consumeWinningBucket(c, out, roundHighBets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio012) {
            c = _consumeWinningBucket(c, out, roundTrio012Bets[c.rid][c.mid]);
        }
        if (c.payoutCount < c.payoutMax && wt.trio023) {
            c = _consumeWinningBucket(c, out, roundTrio023Bets[c.rid][c.mid]);
        }

        uint256 written = c.payoutCount;
        assembly {
            mstore(out, written)
        }
        if (written > 0) {
            result.bankPaid = IBankVault(bank).payoutBatch(out);
        }

        unchecked {
            nextCursor = cursorStart + written;
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
            for (uint256 i; i < len;) {
                uint256 gi = c.gPos + i;
                if (gi >= c.cursorStart && c.payoutCount < c.payoutMax) {
                    BetEntry storage bet = bucket[i];
                    out[c.payoutCount] = IBankVault.Payout(bet.player, _payoutForBet(bet));
                    c.payoutCount++;
                }
                ++i;
            }
            c.gPos += len;
        }
        return c;
    }

    /// @notice Map `pick` uniformly into the k-th jackpot-eligible bet across `_roundMarkets`.
    function _resolveJackpotWinner(uint64 roundId, uint256, uint256 vrfWord2)
        private
        view
        returns (uint32 winnerMarketId, uint256 winnerBetIndex)
    {
        uint256 eligibleCount;

        uint32[] storage markets = _roundMarkets[roundId];
        for (uint256 mi; mi < markets.length; ) {
            uint32 mid = markets[mi];
            eligibleCount += _jackpotEligibleBets[roundId][mid].length;
            unchecked {
                ++mi;
            }
        }

        if (eligibleCount == 0) return (0, 0);

        uint256 pick = vrfWord2 % eligibleCount;

        for (uint256 mi; mi < markets.length; ) {
            uint32 mid = markets[mi];
            BetEntry[] storage elig = _jackpotEligibleBets[roundId][mid];
            for (uint256 j; j < elig.length; ) {
                if (pick == 0) {
                    return (mid, j);
                }
                unchecked {
                    --pick;
                }
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++mi;
            }
        }
        revert InvalidRound();
    }

    function _findFirstPayout(uint32 totalMarkets) private view returns (uint64, uint32) {
        for (uint64 roundId = 1; roundId <= _globalRound; ) {
            if (globalRoundState[roundId].vrfFulfilled) {
                for (uint32 marketId = 1; marketId <= totalMarkets; ) {
                    MarketRoundState storage mr = marketRoundStateByRound[roundId][marketId];
                    if (!mr.settled && mr.totals.betCount > 0) {
                        return (roundId, marketId);
                    }
                    unchecked { ++marketId; }
                }
            }
            unchecked { ++roundId; }
        }
        return (0, 0);
    }

    function _nextCursor(uint32 cursor, uint32 totalMarkets) private pure returns (uint32) {
        return cursor == totalMarkets ? 1 : cursor + 1;
    }

    function _isRoundDone(uint64 roundId) private view returns (bool) {
        uint32[] storage markets = _roundMarkets[roundId];
        for (uint256 i; i < markets.length; ) {
            uint32 marketId = markets[i];
            if (!marketRoundStateByRound[roundId][marketId].settled) return false;
            unchecked { ++i; }
        }
        return true;
    }

    function _decodeAndValidateBet(bytes calldata betData) private pure returns (uint8 betType, uint16 number) {
        (uint256 t, uint256 n) = abi.decode(betData, (uint256, uint256));
        if (t == 0 || t > BET_TRIO_023) revert InvalidBetType();
        _validateBetNumber(t, n);
        betType = uint8(t);
        number = uint16(n);
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
        revert InvalidBetType();
    }

}
