// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title ISideBet — BRBGAME single-player side bets resolved over a window of roulette spins.
/// @notice A player stakes against the house bankroll on a parametrised outcome that resolves
///         over `windowSpins` consecutive roulette results. Payout is a fixed multiple of the
///         stake (`multiplierBps`). Spin results are fed by an authorised keeper relaying the
///         main `RouletteEngine` outcomes — this contract never touches the engine itself.
interface ISideBet {
    /// @dev Order MUST match the subgraph `SideBetType` enum (schema.graphql).
    ///      New types are appended so existing indices stay stable.
    enum SideBetType {
        COLOR_COUNT,
        NUMBER_HIT,
        CONSECUTIVE_STREAK,
        RED_RATIO,
        LIGHTNING_DOUBLE,
        PERFECT_ALTERNATION,
        DOZEN_HIT,
        COLUMN_HIT
    }

    /// @dev Order MUST match the subgraph `SideBetColor` enum.
    enum SideBetColor {
        RED,
        BLACK
    }

    /// @dev Order MUST match the subgraph `SideBetStatus` enum.
    enum SideBetStatus {
        ACTIVE,
        WON,
        LOST,
        EXPIRED,
        CANCELLED
    }

    /// @notice Admin-managed bet template. Bounds the odds (multiplier band) and stake range so
    ///         the house edge stays controlled. `configId` is the index in insertion order.
    struct SideBetConfig {
        address token; // ERC-20 staked / paid in (one token per config)
        SideBetType betType;
        SideBetColor color; // COLOR_COUNT / CONSECUTIVE_STREAK
        uint8 targetNumber; // NUMBER_HIT (0-36); LIGHTNING_DOUBLE (0-36, or 37 = any number); DOZEN_HIT / COLUMN_HIT (1-3)
        uint16 targetCount; // COLOR_COUNT / NUMBER_HIT / CONSECUTIVE_STREAK / LIGHTNING_DOUBLE (run length) / DOZEN_HIT / COLUMN_HIT
        uint16 redRatioBps; // RED_RATIO (1-10000)
        uint16 windowSpins; // spins observed before final resolution
        uint32 multiplierBps; // payout = stake * multiplierBps / 10_000
        uint256 minStake;
        uint256 maxStake;
        bool enabled;
    }

    /// @notice A placed bet. Resolution-relevant params are snapshotted so a later config edit
    ///         cannot change the outcome of an already-active bet.
    struct Bet {
        address player;
        address token;
        uint256 stake;
        uint256 payout; // potential payout reserved from the bankroll
        uint64 startSpinIndex; // first spin observed (spins recorded at/after placement)
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

    event SpinRecorded(uint256 indexed index, uint8 number);
    event ConfigAdded(uint256 indexed configId, address indexed token, SideBetType betType);
    event ConfigUpdated(uint256 indexed configId, bool enabled);
    event MultiplierBandUpdated(uint32 minMultiplierBps, uint32 maxMultiplierBps);
    event ResolverFeeUpdated(uint16 resolverFeeBps);
    event BankrollFunded(address indexed token, address indexed from, uint256 amount);
    event BankrollWithdrawn(address indexed token, address indexed to, uint256 amount);
    event SideBetPlaced(
        uint256 indexed betId,
        address indexed player,
        uint256 indexed configId,
        address token,
        uint256 stake,
        uint256 payout,
        uint64 startSpinIndex,
        uint16 windowSpins
    );
    event SideBetSettled(
        uint256 indexed betId,
        address indexed player,
        SideBetStatus outcome,
        uint256 payout,
        address resolver,
        uint256 resolverFee
    );

    error ZeroAddress();
    error ZeroAmount();
    error InvalidNumber();
    error InvalidConfig();
    error UnknownConfig();
    error ConfigDisabled();
    error StakeOutOfRange();
    error InsufficientBankroll();
    error NotResolvableYet();
    error AlreadyResolved();
    error MultiplierOutOfBand();

    function recordSpin(uint8 number) external;
    function recordSpins(uint8[] calldata numbers) external;
    function addConfig(SideBetConfig calldata cfg) external returns (uint256 configId);
    function updateConfig(uint256 configId, SideBetConfig calldata cfg) external;
    function setConfigEnabled(uint256 configId, bool enabled) external;
    function fundBankroll(address token, uint256 amount) external;
    function withdrawBankroll(address token, uint256 amount, address to) external;
    function placeBet(uint256 configId, uint256 stake) external returns (uint256 betId);
    function resolve(uint256 betId) external;

    function getBet(uint256 betId) external view returns (Bet memory);
    function getConfig(uint256 configId) external view returns (SideBetConfig memory);
    function configCount() external view returns (uint256);
    function betCount() external view returns (uint256);
    function spinCount() external view returns (uint256);
    function getSpins(uint256 from, uint256 count) external view returns (uint8[] memory);
    function bankrollOf(address token) external view returns (uint256);
    function reservedOf(address token) external view returns (uint256);
    function idleBankrollOf(address token) external view returns (uint256);
    function playerBetCount(address player) external view returns (uint256);
    function playerBetAt(address player, uint256 index) external view returns (uint256 betId);
    function isResolvable(uint256 betId) external view returns (bool);
}
