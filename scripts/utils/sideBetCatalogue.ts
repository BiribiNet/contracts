/**
 * BRBGAME side-bet catalogue — the bet templates seeded onto `SideBet` for every registered market.
 *
 * WHY THIS FILE EXISTS: `SideBet` ships with `configCount == 0`, and neither the deploy scripts nor
 * the Ignition module ever called `addConfig`. With no config the whole product is inert —
 * `placeBet` reverts `UnknownConfig` and the frontend renders its "no side bets are open" empty
 * state. This catalogue is the single source of truth for what gets seeded.
 *
 * MULTIPLIER DERIVATION: every `multiplierBps` below is `(1 - HOUSE_EDGE) / p`, where `p` is the
 * win probability of that exact parameter set under `SideBetOutcomeLib.evaluate` on a 37-pocket
 * European wheel. The probabilities were measured by simulating the library's semantics (400k
 * trials per entry) rather than derived by hand, because several kinds resolve early (a win is
 * awarded the moment it becomes certain) and closed forms would not match the contract.
 *
 * Every entry is checked against `SideBet._validateConfigCore` by `test/SideBetCatalogue.test.ts`.
 */

/** `ISideBet.SideBetType` — order must match the enum in `contracts/interfaces/ISideBet.sol`. */
export const SIDE_BET_TYPE = {
    COLOR_COUNT: 0,
    NUMBER_HIT: 1,
    CONSECUTIVE_STREAK: 2,
    RED_RATIO: 3,
    LIGHTNING_DOUBLE: 4,
    PERFECT_ALTERNATION: 5,
    DOZEN_HIT: 6,
    COLUMN_HIT: 7,
    JACKPOT_IN_WINDOW: 8,
} as const;

/** `ISideBet.SideBetColor`. */
export const SIDE_BET_COLOR = {
    RED: 0,
    BLACK: 1,
} as const;

/** `SideBetOutcomeLib.ANY_NUMBER` — the LIGHTNING_DOUBLE "any pocket" sentinel. */
export const ANY_NUMBER = 37;

/** Basis-point denominator used across `SideBet` (`BPS_DENOMINATOR`). */
export const BPS_DENOMINATOR = 10_000n;

/** The multiplier band `SideBet` was initialised with (5x - 500x). Entries must fall inside it. */
export const MIN_MULTIPLIER_BPS = 50_000;
export const MAX_MULTIPLIER_BPS = 5_000_000;

/**
 * Share of a vault's free liquidity a single maximum-size bet may reserve.
 *
 * `availableVaultLiquidity` reports the whole free pool, but `BankVault4626.lockSideBetStake`
 * also subtracts the open roulette round's worst-case liability before checking the reserve. Capping
 * one bet at a fraction of the pool leaves room for that liability and for concurrent side bets,
 * instead of letting the first bettor reserve everything.
 */
export const DEFAULT_LIQUIDITY_SAFETY_BPS = 2_000n;

/** A bet template, minus the market it is bound to and its stake limits. */
export interface SideBetTemplate {
    /** Human-readable id used in logs and for idempotency reporting. */
    readonly key: string;
    readonly betType: number;
    readonly color: number;
    readonly targetNumber: number;
    readonly targetCount: number;
    readonly redRatioBps: number;
    readonly windowSpins: number;
    readonly multiplierBps: number;
    /** Measured win probability, kept alongside the multiplier so the two cannot drift apart. */
    readonly winProbability: number;
}

/**
 * House edge baked into every multiplier. Raising it lowers every payout proportionally.
 */
export const HOUSE_EDGE = 0.05;

/**
 * The nine templates, one per `SideBetType`, ordered from shortest to longest odds.
 *
 * `windowSpins` counts GLOBAL ROUNDS, not per-market spins, and global rounds only advance when
 * somebody places a roulette bet. A quiet market therefore leaves bets undecided, which is what
 * `SideBet.settleTimeout` exists to unstick — see `scripts/upgradeSideBet.ts`.
 */
export const SIDE_BET_TEMPLATES: readonly SideBetTemplate[] = [
    {
        // p = 1 - (36/37)^5: number 7 shows at least once in five rounds.
        key: "NUMBER_HIT_7_IN_5",
        betType: SIDE_BET_TYPE.NUMBER_HIT,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 5,
        multiplierBps: 73_977,
        winProbability: 0.1284,
    },
    {
        // Any pocket repeating back-to-back inside six rounds.
        key: "LIGHTNING_DOUBLE_ANY_IN_6",
        betType: SIDE_BET_TYPE.LIGHTNING_DOUBLE,
        color: SIDE_BET_COLOR.RED,
        targetNumber: ANY_NUMBER,
        targetCount: 2,
        redRatioBps: 0,
        windowSpins: 6,
        multiplierBps: 74_756,
        winProbability: 0.1271,
    },
    {
        // Five reds among six rounds (order irrelevant); zero counts for neither colour.
        key: "COLOR_COUNT_RED_5_IN_6",
        betType: SIDE_BET_TYPE.COLOR_COUNT,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 0,
        targetCount: 5,
        redRatioBps: 0,
        windowSpins: 6,
        multiplierBps: 97_847,
        winProbability: 0.0971,
    },
    {
        // The engine triggers the jackpot when winningNumber == randomWords[1] % 37, so p = 1/37
        // per round and 1 - (36/37)^3 over the window. Other fields are unused for this kind.
        key: "JACKPOT_IN_3",
        betType: SIDE_BET_TYPE.JACKPOT_IN_WINDOW,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 0,
        targetCount: 0,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 120_300,
        winProbability: 0.079,
    },
    {
        // Five blacks in an unbroken run somewhere inside eight rounds.
        key: "CONSECUTIVE_STREAK_BLACK_5_IN_8",
        betType: SIDE_BET_TYPE.CONSECUTIVE_STREAK,
        color: SIDE_BET_COLOR.BLACK,
        targetNumber: 0,
        targetCount: 5,
        redRatioBps: 0,
        windowSpins: 8,
        multiplierBps: 138_828,
        winProbability: 0.0684,
    },
    {
        // Colours alternate strictly for five rounds; a zero or any repeated colour kills it.
        key: "PERFECT_ALTERNATION_5",
        betType: SIDE_BET_TYPE.PERFECT_ALTERNATION,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 0,
        targetCount: 0,
        redRatioBps: 0,
        windowSpins: 5,
        multiplierBps: 175_820,
        winProbability: 0.054,
    },
    {
        // At least 80% reds over ten rounds — the contract rounds the requirement up (ceil).
        key: "RED_RATIO_80_IN_10",
        betType: SIDE_BET_TYPE.RED_RATIO,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 0,
        targetCount: 0,
        redRatioBps: 8_000,
        windowSpins: 10,
        multiplierBps: 208_345,
        winProbability: 0.0456,
    },
    {
        // Column 2 lands six times in eight rounds.
        key: "COLUMN_HIT_2_SIX_IN_8",
        betType: SIDE_BET_TYPE.COLUMN_HIT,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 2,
        targetCount: 6,
        redRatioBps: 0,
        windowSpins: 8,
        multiplierBps: 557_103,
        winProbability: 0.0171,
    },
    {
        // First dozen lands five times in six rounds — the longest odds in the catalogue.
        key: "DOZEN_HIT_1_FIVE_IN_6",
        betType: SIDE_BET_TYPE.DOZEN_HIT,
        color: SIDE_BET_COLOR.RED,
        targetNumber: 1,
        targetCount: 5,
        redRatioBps: 0,
        windowSpins: 6,
        multiplierBps: 601_266,
        winProbability: 0.0158,
    },
] as const;

/** A catalogue entry bound to a market, ready to be passed to `addConfig`. */
export interface SideBetCatalogueEntry extends SideBetTemplate {
    readonly marketId: number;
}

/** The nine templates bound to `marketId`. */
export function buildCatalogueForMarket(marketId: number): SideBetCatalogueEntry[] {
    return SIDE_BET_TEMPLATES.map((template) => ({ ...template, marketId }));
}

/** The tuple shape `ISideBet.SideBetConfig` expects, in declaration order. */
export interface SideBetConfigStruct {
    marketId: number;
    betType: number;
    color: number;
    targetNumber: number;
    targetCount: number;
    redRatioBps: number;
    windowSpins: number;
    multiplierBps: number;
    minStake: bigint;
    maxStake: bigint;
}

/**
 * Build the `addConfig` argument for an entry.
 *
 * `minStake`/`maxStake` are passed as 0 because `addConfig` overwrites them with 0 regardless
 * (`SideBet.sol`, "stored.minStake = 0"). Limits are applied afterwards by `setConfigStakeLimits`,
 * which is what actually makes a config playable — `placeBet` reverts `StakeLimitsNotSet` until then.
 */
export function toConfigStruct(entry: SideBetCatalogueEntry): SideBetConfigStruct {
    return {
        marketId: entry.marketId,
        betType: entry.betType,
        color: entry.color,
        targetNumber: entry.targetNumber,
        targetCount: entry.targetCount,
        redRatioBps: entry.redRatioBps,
        windowSpins: entry.windowSpins,
        multiplierBps: entry.multiplierBps,
        minStake: 0n,
        maxStake: 0n,
    };
}

/**
 * Largest stake a vault holding `availableLiquidity` can back for this multiplier.
 *
 * `lockSideBetStake` requires `free + stake >= stake * multiplier`, i.e.
 * `stake <= free / (multiplier - 1)`. `safetyBps` reserves the rest of the pool for the open
 * roulette round's liability and for concurrent side bets. Returns 0 when the pool cannot back
 * even a dust bet.
 */
export function computeMaxStake(
    availableLiquidity: bigint,
    multiplierBps: number,
    safetyBps: bigint = DEFAULT_LIQUIDITY_SAFETY_BPS,
): bigint {
    const excessBps = BigInt(multiplierBps) - BPS_DENOMINATOR;
    if (excessBps <= 0n) return 0n;
    const budget = (availableLiquidity * safetyBps) / BPS_DENOMINATOR;
    return (budget * BPS_DENOMINATOR) / excessBps;
}

/** Two catalogue entries are the same template when every on-chain config field matches. */
export function matchesConfig(entry: SideBetCatalogueEntry, onChain: SideBetConfigStruct): boolean {
    return (
        onChain.marketId === entry.marketId &&
        onChain.betType === entry.betType &&
        onChain.targetNumber === entry.targetNumber &&
        onChain.targetCount === entry.targetCount &&
        onChain.redRatioBps === entry.redRatioBps &&
        onChain.windowSpins === entry.windowSpins &&
        onChain.multiplierBps === entry.multiplierBps &&
        // `color` only carries meaning for the colour-driven kinds; the contract stores whatever
        // was passed for the others, so comparing it there would cause spurious mismatches.
        (!isColorSignificant(entry.betType) || onChain.color === entry.color)
    );
}

/** Whether `SideBetOutcomeLib` reads `color` for this bet kind. */
export function isColorSignificant(betType: number): boolean {
    return betType === SIDE_BET_TYPE.COLOR_COUNT || betType === SIDE_BET_TYPE.CONSECUTIVE_STREAK;
}
