// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBankVault } from "./IBankVault.sol";

/// @title ISideBet — single-player side bets resolved over a window of global roulette rounds.
/// @notice Stakes and payouts use each market's `BankVault4626` LP pool. Outcomes are read from `RouletteEngine`.
interface ISideBet {
    /// @dev Order MUST match the subgraph `SideBetType` enum (schema.graphql).
    enum SideBetType {
        COLOR_COUNT,
        NUMBER_HIT,
        CONSECUTIVE_STREAK,
        RED_RATIO,
        LIGHTNING_DOUBLE,
        PERFECT_ALTERNATION,
        DOZEN_HIT,
        COLUMN_HIT,
        JACKPOT_IN_WINDOW
    }

    enum SideBetColor {
        RED,
        BLACK
    }

    enum SideBetStatus {
        ACTIVE,
        WON,
        LOST,
        EXPIRED,
        CANCELLED
    }

    struct SideBetConfig {
        uint32 marketId;
        SideBetType betType;
        SideBetColor color;
        uint8 targetNumber;
        uint16 targetCount;
        uint16 redRatioBps;
        uint16 windowSpins;
        uint32 multiplierBps;
        uint256 minStake;
        uint256 maxStake;
    }

    struct Bet {
        address player;
        uint32 marketId;
        uint256 stake;
        uint256 payout;
        uint64 startGlobalRound;
        uint16 windowSpins;
        SideBetType betType;
        SideBetColor color;
        uint8 targetNumber;
        uint16 targetCount;
        uint16 redRatioBps;
        SideBetStatus status;
        uint64 placedAt;
        uint64 resolvedAt;
    }

    /// @dev Outcome row built in `previewSettleBundle` during Automation `checkUpkeep`; applied in `settleBatch`.
    /// @param payoutAmount Player payout when `won`; zero when lost.
    struct SettleRow {
        uint256 betId;
        bool won;
        uint256 payoutAmount;
    }

    /// @dev Per-vault apply bundle built in `previewSettleBundle`; passed through Automation `performData`.
    struct SettleVaultApply {
        address bank;
        uint32 marketId;
        uint256 releaseTotal;
        uint256 totalStakes;
        uint256 totalPaid;
        IBankVault.Payout[] winnerPayouts;
    }

    event ConfigAdded(uint256 configId, uint32 marketId, SideBetType betType);
    event ConfigUpdated(uint256 configId);
    event ConfigRemoved(uint256 configId);
    event ConfigStakeLimitsUpdated(uint256 configId, uint256 minStake, uint256 maxStake);
    event MultiplierBandUpdated(uint32 minMultiplierBps, uint32 maxMultiplierBps);
    event SideBetPlaced(
        uint256 betId,
        address player,
        uint256 configId,
        uint32 marketId,
        uint256 stake,
        uint256 payout,
        uint64 startGlobalRound,
        uint16 windowSpins
    );
    event SideBetSettled(uint256 betId, address player, SideBetStatus outcome, uint256 payout);
    event SideBetJackpotFunded(uint32 marketId, uint256 amount);
    event SideBetInfrastructureFeePaid(uint32 marketId, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidNumber();
    error InvalidConfig();
    error UnknownConfig();
    error ConfigInactive();
    error UnknownMarket();
    error StakeOutOfRange();
    error StakeLimitsNotSet();
    error InsufficientVaultLiquidity();
    error NotResolvableYet();
    error AlreadyResolved();
    error MultiplierOutOfBand();
    /// @dev The start round's VRF is already fulfilled, so its outcome is public — betting on it is closed.
    error RoundOutcomeAlreadyKnown();

    function addConfig(SideBetConfig calldata cfg) external returns (uint256 configId);
    function updateConfig(uint256 configId, SideBetConfig calldata cfg) external;
    function removeConfig(uint256 configId) external;
    function setConfigStakeLimits(uint256 configId, uint256 minStake, uint256 maxStake) external;
    function isConfigActive(uint256 configId) external view returns (bool active);
    function placeBet(uint256 configId, uint256 stake) external returns (uint256 betId);
    /// @notice Simulation-only bundle for one automation lane (`betId % laneCount == lane`).
    function previewSettleBundle(uint256 cursorBetId, uint32 maxBets, uint32 lane, uint32 laneCount)
        external
        view
        returns (SettleRow[] memory rows, uint256 nextCursorBetId, SettleVaultApply[] memory vaultApplies);
    /// @notice Apply-only: bet rows + pre-built vault bundles from `previewSettleBundle` (trusted scheduler + DON).
    function settleBatch(SettleRow[] calldata rows, SettleVaultApply[] calldata vaultApplies) external returns (uint256 settled);

    function getBet(uint256 betId) external view returns (Bet memory);
    function getConfig(uint256 configId) external view returns (SideBetConfig memory);
    function configCount() external view returns (uint256);
    function betCount() external view returns (uint256);
    function reservedOf(uint32 marketId) external view returns (uint256);
    function availableVaultLiquidity(uint32 marketId) external view returns (uint256);
    function playerBetCount(address player) external view returns (uint256);
    function playerBetAt(address player, uint256 index) external view returns (uint256 betId);
    function isResolvable(uint256 betId) external view returns (bool);
}
