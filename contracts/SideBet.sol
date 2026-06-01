// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { ISideBet } from "./interfaces/ISideBet.sol";
import { IBankVault } from "./interfaces/IBankVault.sol";
import { ISideBetVault } from "./interfaces/ISideBetVault.sol";
import { IRouletteEngine } from "./interfaces/IRouletteEngine.sol";
import { IMarketRegistry } from "./interfaces/IMarketRegistry.sol";
import { SideBetOutcomeLib } from "./libraries/SideBetOutcomeLib.sol";
import { SideBetRoundLib } from "./libraries/SideBetRoundLib.sol";
import { MarketFeeLib } from "./libraries/MarketFeeLib.sol";
import { IRouletteFeeConfig } from "./interfaces/IRouletteFeeConfig.sol";
import { IBRBJackpotFunder } from "./interfaces/IBRBJackpotFunder.sol";

/// @title SideBet — BRBGAME single-player side bets (UUPS upgradeable).
/// @notice Players stake against a per-market vault on outcomes resolved over global roulette rounds.
///         Settlement is automation-only: `previewSettleBundle` in `checkUpkeep`, apply-only `settleBatch` in `performUpkeep`.
contract SideBet is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient, ISideBet {
    bytes32 public constant SIDE_BET_CONFIG_ROLE = keccak256("SIDE_BET_CONFIG_ROLE");
    bytes32 public constant SIDE_BET_LIMITS_ROLE = keccak256("SIDE_BET_LIMITS_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint8 private constant MAX_ROULETTE_NUMBER = 36;

    IRouletteEngine public ENGINE;
    IMarketRegistry public REGISTRY;

    /// @custom:storage-location erc7201:biribi.storage.SideBet
    struct SideBetData {
        uint256 configCount;
        mapping(uint256 => SideBetConfig) configs;
        uint256 betCount;
        mapping(uint256 => Bet) bets;
        mapping(address => uint256[]) playerBets;
        uint32 minMultiplierBps;
        uint32 maxMultiplierBps;
        IBRBJackpotFunder jackpotFunder;
        address infraRecipient;
    }

    // keccak256(abi.encode(uint256(keccak256("biribi.storage.SideBet")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant SIDE_BET_STORAGE_LOCATION =
        0x1846f22cbddf11ab4f03976bc184e4c229eb24d5ca6fd07bdce57e89b8a62c00;

    /// @dev Working buffers for `_previewVaultApplies` (keeps parent function off the stack limit).
    struct PreviewVaultScratch {
        address[] banks;
        uint32[] marketIds;
        uint256[] releaseTotals;
        uint256[] totalStakes;
        uint256[] totalPaid;
        IBankVault.Payout[] winnerPayouts;
        uint256[] winnerCounts;
        uint256 vaultCount;
    }

    function _s() private pure returns (SideBetData storage $) {
        assembly {
            $.slot := SIDE_BET_STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address engine,
        address registry,
        uint32 minMultiplierBps_,
        uint32 maxMultiplierBps_
    ) external initializer {
        if (admin == address(0) || engine == address(0) || registry == address(0)) revert ZeroAddress();
        if (minMultiplierBps_ <= BPS_DENOMINATOR || maxMultiplierBps_ < minMultiplierBps_) revert InvalidConfig();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIDE_BET_CONFIG_ROLE, admin);
        _grantRole(SIDE_BET_LIMITS_ROLE, admin);

        ENGINE = IRouletteEngine(engine);
        REGISTRY = IMarketRegistry(registry);

        SideBetData storage $ = _s();
        IRouletteFeeConfig feeCfg = IRouletteFeeConfig(engine);
        $.jackpotFunder = IBRBJackpotFunder(feeCfg.JACKPOT_FUNDER());
        $.infraRecipient = feeCfg.INFRA_RECIPIENT();
        $.minMultiplierBps = minMultiplierBps_;
        $.maxMultiplierBps = maxMultiplierBps_;

        emit MultiplierBandUpdated(minMultiplierBps_, maxMultiplierBps_);
    }

    // --- Config management ---------------------------------------------------

    function addConfig(SideBetConfig calldata cfg) external override onlyRole(SIDE_BET_CONFIG_ROLE) returns (uint256 configId) {
        _validateConfigCore(cfg);
        SideBetData storage $ = _s();
        configId = $.configCount;
        SideBetConfig storage stored = $.configs[configId];
        stored.marketId = cfg.marketId;
        stored.betType = cfg.betType;
        stored.color = cfg.color;
        stored.targetNumber = cfg.targetNumber;
        stored.targetCount = cfg.targetCount;
        stored.redRatioBps = cfg.redRatioBps;
        stored.windowSpins = cfg.windowSpins;
        stored.multiplierBps = cfg.multiplierBps;
        stored.minStake = 0;
        stored.maxStake = 0;
        $.configCount = configId + 1;
        emit ConfigAdded(configId, cfg.marketId, cfg.betType);
    }

    function removeConfig(uint256 configId) external override onlyRole(SIDE_BET_CONFIG_ROLE) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig storage stored = $.configs[configId];
        if (stored.marketId == 0) revert ConfigInactive();
        _clearConfig(stored);
        emit ConfigRemoved(configId);
    }

    function updateConfig(uint256 configId, SideBetConfig calldata cfg) external override onlyRole(SIDE_BET_CONFIG_ROLE) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig storage stored = $.configs[configId];
        if (stored.marketId == 0) revert ConfigInactive();
        _validateConfigCore(cfg);
        uint256 minStake = stored.minStake;
        uint256 maxStake = stored.maxStake;
        stored.marketId = cfg.marketId;
        stored.betType = cfg.betType;
        stored.color = cfg.color;
        stored.targetNumber = cfg.targetNumber;
        stored.targetCount = cfg.targetCount;
        stored.redRatioBps = cfg.redRatioBps;
        stored.windowSpins = cfg.windowSpins;
        stored.multiplierBps = cfg.multiplierBps;
        stored.minStake = minStake;
        stored.maxStake = maxStake;
        emit ConfigUpdated(configId);
    }

    function setConfigStakeLimits(uint256 configId, uint256 minStake, uint256 maxStake)
        external
        override
        onlyRole(SIDE_BET_LIMITS_ROLE)
    {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig storage stored = $.configs[configId];
        if (stored.marketId == 0) revert ConfigInactive();
        if (minStake == 0 || maxStake < minStake) revert InvalidConfig();
        stored.minStake = minStake;
        stored.maxStake = maxStake;
        emit ConfigStakeLimitsUpdated(configId, minStake, maxStake);
    }

    function setMultiplierBand(uint32 minMultiplierBps_, uint32 maxMultiplierBps_) external onlyRole(SIDE_BET_CONFIG_ROLE) {
        if (minMultiplierBps_ <= BPS_DENOMINATOR || maxMultiplierBps_ < minMultiplierBps_) revert InvalidConfig();
        SideBetData storage $ = _s();
        $.minMultiplierBps = minMultiplierBps_;
        $.maxMultiplierBps = maxMultiplierBps_;
        emit MultiplierBandUpdated(minMultiplierBps_, maxMultiplierBps_);
    }

    function _clearConfig(SideBetConfig storage cfg) private {
        cfg.marketId = 0;
        cfg.betType = SideBetType.COLOR_COUNT;
        cfg.color = SideBetColor.RED;
        cfg.targetNumber = 0;
        cfg.targetCount = 0;
        cfg.redRatioBps = 0;
        cfg.windowSpins = 0;
        cfg.multiplierBps = 0;
        cfg.minStake = 0;
        cfg.maxStake = 0;
    }

    function _validateConfigCore(SideBetConfig calldata cfg) private view {
        SideBetData storage $ = _s();
        _marketOrRevert(cfg.marketId);
        if (cfg.windowSpins == 0) revert InvalidConfig();
        if (cfg.multiplierBps < $.minMultiplierBps || cfg.multiplierBps > $.maxMultiplierBps) revert MultiplierOutOfBand();

        if (cfg.betType == SideBetType.NUMBER_HIT) {
            if (cfg.targetNumber > MAX_ROULETTE_NUMBER) revert InvalidConfig();
            if (cfg.targetCount == 0 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.COLOR_COUNT || cfg.betType == SideBetType.CONSECUTIVE_STREAK) {
            if (cfg.targetCount == 0 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.RED_RATIO) {
            if (cfg.redRatioBps == 0 || cfg.redRatioBps > BPS_DENOMINATOR) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.LIGHTNING_DOUBLE) {
            if (cfg.targetNumber > SideBetOutcomeLib.ANY_NUMBER) revert InvalidConfig();
            if (cfg.targetCount < 2 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.PERFECT_ALTERNATION) {
            if (cfg.windowSpins < 2) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.JACKPOT_IN_WINDOW) {
            // `windowSpins` is the number of upcoming global rounds; other fields unused.
        } else {
            if (cfg.targetNumber < 1 || cfg.targetNumber > 3) revert InvalidConfig();
            if (cfg.targetCount == 0 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        }
    }

    function _marketOrRevert(uint32 marketId) private view returns (IMarketRegistry.MarketConfig memory m) {
        if (marketId == 0 || marketId > REGISTRY.marketCount()) revert UnknownMarket();
        m = REGISTRY.getMarket(marketId);
        if (m.bank == address(0)) revert UnknownMarket();
    }

    // --- Betting -------------------------------------------------------------

    function placeBet(uint256 configId, uint256 stake) external override nonReentrant returns (uint256 betId) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig storage cfg = $.configs[configId];
        if (cfg.marketId == 0) revert ConfigInactive();
        if (cfg.minStake == 0) revert StakeLimitsNotSet();
        if (stake < cfg.minStake || stake > cfg.maxStake) revert StakeOutOfRange();

        uint256 payout = (stake * cfg.multiplierBps) / BPS_DENOMINATOR;
        IMarketRegistry.MarketConfig memory m = _marketOrRevert(cfg.marketId);
        ISideBetVault vault = ISideBetVault(m.bank);

        uint64 startGlobalRound = ENGINE.currentGlobalRound();
        betId = $.betCount;
        $.betCount = betId + 1;
        $.bets[betId] = Bet({
            player: msg.sender,
            marketId: cfg.marketId,
            stake: stake,
            payout: payout,
            startGlobalRound: startGlobalRound,
            windowSpins: cfg.windowSpins,
            betType: cfg.betType,
            color: cfg.color,
            targetNumber: cfg.targetNumber,
            targetCount: cfg.targetCount,
            redRatioBps: cfg.redRatioBps,
            status: SideBetStatus.ACTIVE,
            placedAt: uint64(block.timestamp),
            resolvedAt: 0
        });
        $.playerBets[msg.sender].push(betId);

        vault.lockSideBetStake(msg.sender, stake, payout);

        emit SideBetPlaced(betId, msg.sender, configId, cfg.marketId, stake, payout, startGlobalRound, cfg.windowSpins);
    }

    function previewSettleBundle(uint256 cursorBetId, uint32 maxBets, uint32 lane, uint32 laneCount)
        external
        view
        override
        returns (SettleRow[] memory rows, uint256 nextCursorBetId, SettleVaultApply[] memory vaultApplies)
    {
        if (maxBets == 0 || laneCount == 0 || lane >= laneCount) {
            return (new SettleRow[](0), cursorBetId, new SettleVaultApply[](0));
        }

        SideBetData storage $ = _s();
        uint256 total = $.betCount;
        uint256 id = cursorBetId;
        if (id % laneCount != lane) {
            id += (lane - (id % laneCount)) % laneCount;
        }

        SettleRow[] memory found = new SettleRow[](maxBets);
        uint256 n;
        while (n < maxBets && id < total) {
            Bet storage bet = $.bets[id];
            if (bet.status == SideBetStatus.ACTIVE) {
                (bool decided, bool won) = _evaluate(bet);
                if (decided) {
                    found[n] = SettleRow({ betId: id, won: won, payoutAmount: won ? bet.payout : 0 });
                    unchecked {
                        ++n;
                    }
                }
            }
            id += laneCount;
        }

        nextCursorBetId = id;
        if (n != maxBets) {
            rows = new SettleRow[](n);
            for (uint256 i; i < n; ) {
                rows[i] = found[i];
                unchecked {
                    ++i;
                }
            }
        } else {
            rows = found;
        }

        vaultApplies = _previewVaultApplies($, rows);
    }

    function settleBatch(SettleRow[] calldata rows, SettleVaultApply[] calldata vaultApplies)
        external
        override
        nonReentrant
        onlyRole(SETTLEMENT_ROLE)
        returns (uint256 settled)
    {
        SideBetData storage $ = _s();
        for (uint256 i; i < rows.length; ) {
            if (_finalizeSettleRow($, rows[i])) {
                unchecked {
                    ++settled;
                }
            }
            unchecked {
                ++i;
            }
        }

        for (uint256 v; v < vaultApplies.length; ) {
            SettleVaultApply calldata bundle = vaultApplies[v];
            IBankVault bank = IBankVault(bundle.bank);
            bank.releaseBets(bundle.releaseTotal);
            if (bundle.winnerPayouts.length != 0) {
                bank.payoutBatch(bundle.winnerPayouts);
            }
            _collectMarketFees(bundle.marketId, bundle.bank, bundle.totalStakes, bundle.totalPaid);
            unchecked {
                ++v;
            }
        }
    }

    function _collectMarketFees(uint32 marketId, address bank, uint256 totalStakes, uint256 totalPaid) private {
        SideBetData storage $ = _s();
        MarketFeeLib.CollectResult memory fees = MarketFeeLib.collect(
            $.jackpotFunder, $.infraRecipient, bank, marketId, totalStakes, totalPaid
        );
        if (fees.swapIn > 0) emit SideBetJackpotFunded(marketId, fees.swapIn);
        if (fees.infraFee > 0) emit SideBetInfrastructureFeePaid(marketId, fees.infraFee);
    }

    /// @dev Simulation-only grouping for `previewSettleBundle` (mirrors roulette `previewPayoutBundle`).
    function _previewVaultApplies(SideBetData storage $, SettleRow[] memory rows)
        private
        view
        returns (SettleVaultApply[] memory vaultApplies)
    {
        uint256 batchLen = rows.length;
        if (batchLen == 0) return new SettleVaultApply[](0);

        PreviewVaultScratch memory scratch;
        scratch.banks = new address[](batchLen);
        scratch.marketIds = new uint32[](batchLen);
        scratch.releaseTotals = new uint256[](batchLen);
        scratch.totalStakes = new uint256[](batchLen);
        scratch.totalPaid = new uint256[](batchLen);
        scratch.winnerPayouts = new IBankVault.Payout[](batchLen);
        scratch.winnerCounts = new uint256[](batchLen);

        _accumulatePreviewVaultScratch($, rows, scratch);
        return _buildPreviewVaultApplies(scratch);
    }

    function _accumulatePreviewVaultScratch(
        SideBetData storage $,
        SettleRow[] memory rows,
        PreviewVaultScratch memory s
    ) private view {
        uint256 batchLen = rows.length;
        SettleRow memory row;
        Bet storage bet;
        address bank;
        uint256 vaultIdx;
        uint256 payoutIdx;

        for (uint256 i; i < batchLen; ) {
            row = rows[i];
            bet = $.bets[row.betId];
            bank = _marketOrRevert(bet.marketId).bank;

            vaultIdx = _vaultIndex(s.banks, s.vaultCount, bank);
            if (vaultIdx == s.vaultCount) {
                s.banks[s.vaultCount] = bank;
                s.marketIds[s.vaultCount] = bet.marketId;
                vaultIdx = s.vaultCount;
                unchecked {
                    ++s.vaultCount;
                }
            }

            s.releaseTotals[vaultIdx] += bet.payout;
            s.totalStakes[vaultIdx] += bet.stake;
            if (row.won) {
                s.totalPaid[vaultIdx] += row.payoutAmount;
                payoutIdx = s.winnerCounts[vaultIdx];
                for (uint256 u; u < vaultIdx; ) {
                    payoutIdx += s.winnerCounts[u];
                    unchecked {
                        ++u;
                    }
                }
                s.winnerPayouts[payoutIdx] = IBankVault.Payout({ player: bet.player, amount: row.payoutAmount });
                unchecked {
                    ++s.winnerCounts[vaultIdx];
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    function _buildPreviewVaultApplies(PreviewVaultScratch memory s)
        private
        pure
        returns (SettleVaultApply[] memory vaultApplies)
    {
        vaultApplies = new SettleVaultApply[](s.vaultCount);
        uint256 winnerCount;
        IBankVault.Payout[] memory winners;
        uint256 base;

        for (uint256 v; v < s.vaultCount; ) {
            winnerCount = s.winnerCounts[v];
            winners = new IBankVault.Payout[](winnerCount);
            base = 0;
            for (uint256 u; u < v; ) {
                base += s.winnerCounts[u];
                unchecked {
                    ++u;
                }
            }
            for (uint256 w; w < winnerCount; ) {
                winners[w] = s.winnerPayouts[base + w];
                unchecked {
                    ++w;
                }
            }
            vaultApplies[v] = SettleVaultApply({
                bank: s.banks[v],
                marketId: s.marketIds[v],
                releaseTotal: s.releaseTotals[v],
                totalStakes: s.totalStakes[v],
                totalPaid: s.totalPaid[v],
                winnerPayouts: winners
            });
            unchecked {
                ++v;
            }
        }
    }

    /// @dev Marks bet resolved and emits; no vault I/O (batched in `settleBatch`).
    function _finalizeSettleRow(SideBetData storage $, SettleRow calldata row) private returns (bool applied) {
        if (row.betId >= $.betCount) return false;
        Bet storage bet = $.bets[row.betId];
        if (bet.status != SideBetStatus.ACTIVE) return false;

        uint256 reserved = bet.payout;
        if (row.won) {
            if (row.payoutAmount != reserved) return false;
        } else if (row.payoutAmount != 0) {
            return false;
        }

        bet.status = row.won ? SideBetStatus.WON : SideBetStatus.LOST;
        bet.resolvedAt = uint64(block.timestamp);
        emit SideBetSettled(row.betId, bet.player, bet.status, row.payoutAmount);
        return true;
    }

    function _vaultIndex(address[] memory banks, uint256 vaultCount, address bank) private pure returns (uint256) {
        for (uint256 i; i < vaultCount; ) {
            if (banks[i] == bank) return i;
            unchecked {
                ++i;
            }
        }
        return vaultCount;
    }

    function _evaluate(Bet storage bet) private view returns (bool decided, bool won) {
        if (bet.betType == SideBetType.JACKPOT_IN_WINDOW) {
            return SideBetRoundLib.evaluateJackpotWindow(ENGINE, bet.startGlobalRound, bet.windowSpins);
        }

        uint64 start = bet.startGlobalRound;
        uint16 windowN = bet.windowSpins;

        uint256 obsLen;
        uint64 cur = ENGINE.currentGlobalRound();
        for (uint64 r = start; obsLen < windowN && r <= cur; ) {
            (bool fulfilled, ) = ENGINE.roundOutcome(r);
            if (!fulfilled) break;
            unchecked {
                ++obsLen;
                ++r;
            }
        }
        if (obsLen == 0) return (false, false);

        (uint8[] memory observed, ) = SideBetRoundLib.loadWindow(ENGINE, start, obsLen);
        bool windowComplete = obsLen == windowN && SideBetRoundLib.windowFulfilled(ENGINE, start, windowN);
        return SideBetOutcomeLib.evaluate(observed, windowComplete, _betMemory(bet));
    }

    function _betMemory(Bet storage bet) private view returns (Bet memory) {
        return Bet({
            player: bet.player,
            marketId: bet.marketId,
            stake: bet.stake,
            payout: bet.payout,
            startGlobalRound: bet.startGlobalRound,
            windowSpins: bet.windowSpins,
            betType: bet.betType,
            color: bet.color,
            targetNumber: bet.targetNumber,
            targetCount: bet.targetCount,
            redRatioBps: bet.redRatioBps,
            status: bet.status,
            placedAt: bet.placedAt,
            resolvedAt: bet.resolvedAt
        });
    }

    // --- Views ---------------------------------------------------------------

    function getBet(uint256 betId) external view override returns (Bet memory) {
        return _s().bets[betId];
    }

    function getConfig(uint256 configId) external view override returns (SideBetConfig memory) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig memory cfg = $.configs[configId];
        if (cfg.marketId == 0) revert ConfigInactive();
        return cfg;
    }

    function isConfigActive(uint256 configId) external view override returns (bool active) {
        SideBetData storage $ = _s();
        return configId < $.configCount && $.configs[configId].marketId != 0;
    }

    function configCount() external view override returns (uint256) {
        return _s().configCount;
    }

    function betCount() external view override returns (uint256) {
        return _s().betCount;
    }

    function reservedOf(uint32 marketId) external view override returns (uint256) {
        SideBetData storage $ = _s();
        uint256 sum;
        for (uint256 id; id < $.betCount; ) {
            Bet storage bet = $.bets[id];
            if (bet.marketId == marketId && bet.status == SideBetStatus.ACTIVE) {
                sum += bet.payout;
            }
            unchecked {
                ++id;
            }
        }
        return sum;
    }

    function availableVaultLiquidity(uint32 marketId) external view override returns (uint256) {
        IMarketRegistry.MarketConfig memory m = _marketOrRevert(marketId);
        return ISideBetVault(m.bank).availableForSideBet();
    }

    function playerBetCount(address player) external view override returns (uint256) {
        return _s().playerBets[player].length;
    }

    function playerBetAt(address player, uint256 index) external view override returns (uint256 betId) {
        return _s().playerBets[player][index];
    }

    function isResolvable(uint256 betId) external view override returns (bool) {
        SideBetData storage $ = _s();
        if (betId >= $.betCount) return false;
        return _isResolvable($, betId);
    }

    function _isResolvable(SideBetData storage $, uint256 betId) private view returns (bool) {
        Bet storage bet = $.bets[betId];
        if (bet.status != SideBetStatus.ACTIVE) return false;
        (bool decided, ) = _evaluate(bet);
        return decided;
    }

    function minMultiplierBps() external view returns (uint32) {
        return _s().minMultiplierBps;
    }

    function maxMultiplierBps() external view returns (uint32) {
        return _s().maxMultiplierBps;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
