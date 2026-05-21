// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { ISideBet } from "./interfaces/ISideBet.sol";
import { SideBetOutcomeLib } from "./libraries/SideBetOutcomeLib.sol";

/// @title SideBet — BRBGAME single-player side bets (UUPS upgradeable).
/// @notice Players stake against a per-token house bankroll on parametrised outcomes that resolve
///         over a window of roulette spins. Spins are fed by an authorised keeper relaying the
///         main `RouletteEngine` results; this contract is fully standalone.
contract SideBet is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient, ISideBet {
    using SafeERC20 for IERC20;

    bytes32 public constant SIDE_BET_ADMIN_ROLE = keccak256("SIDE_BET_ADMIN_ROLE");
    bytes32 public constant SPIN_FEEDER_ROLE = keccak256("SPIN_FEEDER_ROLE");

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint8 private constant MAX_ROULETTE_NUMBER = 36;

    /// @custom:storage-location erc7201:biribi.storage.SideBet
    struct SideBetData {
        uint8[] spins; // global roulette outcome sequence (0-36)
        uint256 configCount;
        mapping(uint256 => SideBetConfig) configs;
        uint256 betCount;
        mapping(uint256 => Bet) bets;
        mapping(address => uint256[]) playerBets;
        mapping(address => uint256) reserved; // token => payout obligations locked by active bets
        uint32 minMultiplierBps;
        uint32 maxMultiplierBps;
        uint16 resolverFeeBps; // share of stake paid to whoever resolves a bet
    }

    // keccak256(abi.encode(uint256(keccak256("biribi.storage.SideBet")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant SIDE_BET_STORAGE_LOCATION =
        0x2a3a3a4c0d2b6f7d9c4d6f3f2e6b8c1a5d7e9f0b2c4a6e8d0f1a3c5e7b9d1f00;

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
        uint32 minMultiplierBps_,
        uint32 maxMultiplierBps_,
        uint16 resolverFeeBps_
    ) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        // Side bets pay more than the stake, so the lower band must exceed 1x.
        if (minMultiplierBps_ <= BPS_DENOMINATOR || maxMultiplierBps_ < minMultiplierBps_) revert InvalidConfig();
        if (resolverFeeBps_ > BPS_DENOMINATOR) revert InvalidConfig();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIDE_BET_ADMIN_ROLE, admin);

        SideBetData storage $ = _s();
        $.minMultiplierBps = minMultiplierBps_;
        $.maxMultiplierBps = maxMultiplierBps_;
        $.resolverFeeBps = resolverFeeBps_;

        emit MultiplierBandUpdated(minMultiplierBps_, maxMultiplierBps_);
        emit ResolverFeeUpdated(resolverFeeBps_);
    }

    // --- Spin feed -----------------------------------------------------------

    function recordSpin(uint8 number) external override onlyRole(SPIN_FEEDER_ROLE) {
        _recordSpin(number);
    }

    function recordSpins(uint8[] calldata numbers) external override onlyRole(SPIN_FEEDER_ROLE) {
        for (uint256 i; i < numbers.length; ++i) {
            _recordSpin(numbers[i]);
        }
    }

    function _recordSpin(uint8 number) private {
        if (number > MAX_ROULETTE_NUMBER) revert InvalidNumber();
        SideBetData storage $ = _s();
        uint256 index = $.spins.length;
        $.spins.push(number);
        emit SpinRecorded(index, number);
    }

    // --- Config management ---------------------------------------------------

    function addConfig(SideBetConfig calldata cfg) external override onlyRole(SIDE_BET_ADMIN_ROLE) returns (uint256 configId) {
        _validateConfig(cfg);
        SideBetData storage $ = _s();
        configId = $.configCount;
        $.configs[configId] = cfg;
        $.configCount = configId + 1;
        emit ConfigAdded(configId, cfg.token, cfg.betType);
        emit ConfigUpdated(configId, cfg.enabled);
    }

    function updateConfig(uint256 configId, SideBetConfig calldata cfg) external override onlyRole(SIDE_BET_ADMIN_ROLE) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        _validateConfig(cfg);
        $.configs[configId] = cfg;
        emit ConfigUpdated(configId, cfg.enabled);
    }

    function setConfigEnabled(uint256 configId, bool enabled) external override onlyRole(SIDE_BET_ADMIN_ROLE) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        $.configs[configId].enabled = enabled;
        emit ConfigUpdated(configId, enabled);
    }

    function setMultiplierBand(uint32 minMultiplierBps_, uint32 maxMultiplierBps_) external onlyRole(SIDE_BET_ADMIN_ROLE) {
        if (minMultiplierBps_ <= BPS_DENOMINATOR || maxMultiplierBps_ < minMultiplierBps_) revert InvalidConfig();
        SideBetData storage $ = _s();
        $.minMultiplierBps = minMultiplierBps_;
        $.maxMultiplierBps = maxMultiplierBps_;
        emit MultiplierBandUpdated(minMultiplierBps_, maxMultiplierBps_);
    }

    function setResolverFeeBps(uint16 resolverFeeBps_) external onlyRole(SIDE_BET_ADMIN_ROLE) {
        if (resolverFeeBps_ > BPS_DENOMINATOR) revert InvalidConfig();
        _s().resolverFeeBps = resolverFeeBps_;
        emit ResolverFeeUpdated(resolverFeeBps_);
    }

    function _validateConfig(SideBetConfig calldata cfg) private view {
        SideBetData storage $ = _s();
        if (cfg.token == address(0)) revert InvalidConfig();
        if (cfg.windowSpins == 0) revert InvalidConfig();
        if (cfg.minStake == 0 || cfg.maxStake < cfg.minStake) revert InvalidConfig();
        if (cfg.multiplierBps < $.minMultiplierBps || cfg.multiplierBps > $.maxMultiplierBps) revert MultiplierOutOfBand();

        if (cfg.betType == SideBetType.NUMBER_HIT) {
            if (cfg.targetNumber > MAX_ROULETTE_NUMBER) revert InvalidConfig();
            if (cfg.targetCount == 0 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        } else if (cfg.betType == SideBetType.COLOR_COUNT || cfg.betType == SideBetType.CONSECUTIVE_STREAK) {
            if (cfg.targetCount == 0 || cfg.targetCount > cfg.windowSpins) revert InvalidConfig();
        } else {
            // RED_RATIO
            if (cfg.redRatioBps == 0 || cfg.redRatioBps > BPS_DENOMINATOR) revert InvalidConfig();
        }
    }

    // --- Bankroll ------------------------------------------------------------

    function fundBankroll(address token, uint256 amount) external override {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit BankrollFunded(token, msg.sender, amount);
    }

    function withdrawBankroll(address token, uint256 amount, address to) external override onlyRole(SIDE_BET_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > idleBankrollOf(token)) revert InsufficientBankroll();
        IERC20(token).safeTransfer(to, amount);
        emit BankrollWithdrawn(token, to, amount);
    }

    // --- Betting -------------------------------------------------------------

    function placeBet(uint256 configId, uint256 stake) external override nonReentrant returns (uint256 betId) {
        SideBetData storage $ = _s();
        if (configId >= $.configCount) revert UnknownConfig();
        SideBetConfig storage cfg = $.configs[configId];
        if (!cfg.enabled) revert ConfigDisabled();
        if (stake < cfg.minStake || stake > cfg.maxStake) revert StakeOutOfRange();

        uint256 payout = (stake * cfg.multiplierBps) / BPS_DENOMINATOR;
        // The house only needs to cover the winnings (payout - stake); the stake itself is pulled in.
        address token = cfg.token;
        uint256 balanceAfterStake = IERC20(token).balanceOf(address(this)) + stake;
        if (balanceAfterStake < $.reserved[token] + payout) revert InsufficientBankroll();

        // Effects
        betId = $.betCount;
        $.betCount = betId + 1;
        uint64 startSpinIndex = uint64($.spins.length);
        $.bets[betId] = Bet({
            player: msg.sender,
            token: token,
            stake: stake,
            payout: payout,
            startSpinIndex: startSpinIndex,
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
        $.reserved[token] += payout;

        // Interactions
        IERC20(token).safeTransferFrom(msg.sender, address(this), stake);

        emit SideBetPlaced(betId, msg.sender, configId, token, stake, payout, startSpinIndex, cfg.windowSpins);
    }

    function resolve(uint256 betId) external override nonReentrant {
        SideBetData storage $ = _s();
        if (betId >= $.betCount) revert UnknownConfig();
        Bet storage bet = $.bets[betId];
        if (bet.status != SideBetStatus.ACTIVE) revert AlreadyResolved();

        (bool decided, bool won) = _evaluate($, betId);
        if (!decided) revert NotResolvableYet();

        // Effects
        address token = bet.token;
        uint256 payout = bet.payout;
        $.reserved[token] -= payout;
        bet.status = won ? SideBetStatus.WON : SideBetStatus.LOST;
        bet.resolvedAt = uint64(block.timestamp);

        // Interactions
        if (won) {
            IERC20(token).safeTransfer(bet.player, payout);
        }

        uint256 fee = _payResolverFee($, token, bet.stake);

        emit SideBetSettled(betId, bet.player, bet.status, won ? payout : 0, msg.sender, fee);
    }

    /// @dev Pays the caller a capped share of the stake from idle bankroll. Never reverts the
    ///      resolution: if the bankroll cannot cover the full fee it pays whatever is idle.
    function _payResolverFee(SideBetData storage $, address token, uint256 stake) private returns (uint256 fee) {
        uint16 feeBps = $.resolverFeeBps;
        if (feeBps == 0) return 0;
        fee = (stake * feeBps) / BPS_DENOMINATOR;
        uint256 idle = idleBankrollOf(token);
        if (fee > idle) fee = idle;
        if (fee > 0) IERC20(token).safeTransfer(msg.sender, fee);
    }

    function _evaluate(SideBetData storage $, uint256 betId) private view returns (bool decided, bool won) {
        Bet memory bet = $.bets[betId];
        uint256 spinLen = $.spins.length;
        uint256 start = bet.startSpinIndex;
        uint256 available = spinLen > start ? spinLen - start : 0;
        uint256 windowN = bet.windowSpins;
        uint256 obsLen = available > windowN ? windowN : available;

        uint8[] memory observed = new uint8[](obsLen);
        for (uint256 i; i < obsLen; ++i) {
            observed[i] = $.spins[start + i];
        }

        return SideBetOutcomeLib.evaluate(observed, obsLen == windowN, bet);
    }

    // --- Views ---------------------------------------------------------------

    function getBet(uint256 betId) external view override returns (Bet memory) {
        return _s().bets[betId];
    }

    function getConfig(uint256 configId) external view override returns (SideBetConfig memory) {
        return _s().configs[configId];
    }

    function configCount() external view override returns (uint256) {
        return _s().configCount;
    }

    function betCount() external view override returns (uint256) {
        return _s().betCount;
    }

    function spinCount() external view override returns (uint256) {
        return _s().spins.length;
    }

    function getSpins(uint256 from, uint256 count) external view override returns (uint8[] memory) {
        SideBetData storage $ = _s();
        uint256 len = $.spins.length;
        if (from >= len) return new uint8[](0);
        uint256 end = from + count;
        if (end > len) end = len;
        uint8[] memory out = new uint8[](end - from);
        for (uint256 i = from; i < end; ++i) {
            out[i - from] = $.spins[i];
        }
        return out;
    }

    function bankrollOf(address token) public view override returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function reservedOf(address token) external view override returns (uint256) {
        return _s().reserved[token];
    }

    function idleBankrollOf(address token) public view override returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = _s().reserved[token];
        return balance > reserved ? balance - reserved : 0;
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
        Bet storage bet = $.bets[betId];
        if (bet.status != SideBetStatus.ACTIVE) return false;
        (bool decided, ) = _evaluate($, betId);
        return decided;
    }

    function minMultiplierBps() external view returns (uint32) {
        return _s().minMultiplierBps;
    }

    function maxMultiplierBps() external view returns (uint32) {
        return _s().maxMultiplierBps;
    }

    function resolverFeeBps() external view returns (uint16) {
        return _s().resolverFeeBps;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
