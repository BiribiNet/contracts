import { SIDE_BET_COLOR, SIDE_BET_TYPE, type SideBetCatalogueEntry, type SideBetTemplate } from './sideBetCatalogue';

export const X100_HOUSE_EDGE_BPS = 500;
/** Fraction of stake, equivalent to 0.0002 percentage point (excludes token rounding). */
export const X100_EDGE_TOLERANCE = { numerator: 2n, denominator: 1_000_000n };

export function choose(n: number, k: number): bigint {
  let result = 1n;
  for (let i = 1; i <= k; i++) result = (result * BigInt(n - i + 1)) / BigInt(i);
  return result;
}

/** Exact count of sequences with at least target matching pockets. Zero is included
 * in the non-matching weight for colour/dozen bets and matches NUMBER_HIT(0). */
export function hitProbability(window: number, target: number, pockets: number) {
  let wins = 0n;
  for (let hits = target; hits <= window; hits++) {
    wins += choose(window, hits) * BigInt(pockets) ** BigInt(hits) * BigInt(37 - pockets) ** BigInt(window - hits);
  }
  return { wins, total: 37n ** BigInt(window) };
}

/** Absorbing run-length DP: overlapping winning streaks are counted only once. */
export function streakProbability(window: number, target: number) {
  let states = new Map<number, bigint>([[0, 1n]]);
  let wins = 0n;
  for (let step = 0; step < window; step++) {
    wins *= 37n;
    const next = new Map<number, bigint>();
    for (const [run, count] of states) {
      next.set(0, (next.get(0) ?? 0n) + count * 19n);
      if (run + 1 === target) wins += count * 18n;
      else next.set(run + 1, (next.get(run + 1) ?? 0n) + count * 18n);
    }
    states = next;
  }
  return { wins, total: 37n ** BigInt(window) };
}

function offer(
  key: string,
  betType: number,
  windowSpins: number,
  targetCount: number,
  probability: { wins: bigint; total: bigint },
) {
  const multiplierBps = Number((BigInt(10_000 - X100_HOUSE_EDGE_BPS) * probability.total) / probability.wins);
  return {
    key,
    betType,
    windowSpins,
    targetCount,
    multiplierBps,
    wins: probability.wins.toString(),
    total: probability.total.toString(),
    houseEdgeBps: X100_HOUSE_EDGE_BPS,
    winProbability: Number(probability.wins) / Number(probability.total),
  };
}

/** Pricing source for all four families; never use floating point to price a payout. */
export const X100_OFFERS = [
  offer('PERFECT_DOZEN', SIDE_BET_TYPE.DOZEN_HIT, 4, 4, hitProbability(4, 4, 12)),
  offer('DOUBLE_NUMBER', SIDE_BET_TYPE.NUMBER_HIT, 6, 2, hitProbability(6, 2, 1)),
  offer('SEVEN_STREAK', SIDE_BET_TYPE.CONSECUTIVE_STREAK, 8, 7, streakProbability(8, 7)),
  offer('NINE_OF_TEN', SIDE_BET_TYPE.COLOR_COUNT, 10, 9, hitProbability(10, 9, 18)),
] as const;

/** Choices are real configurations: 3 dozens, all 37 numbers (including zero),
 * and both colours for each colour family. No player-selected parameter in placeBet. */
export const X100_TEMPLATES: readonly SideBetTemplate[] = X100_OFFERS.flatMap((entry) => {
  const targets =
    entry.betType === SIDE_BET_TYPE.DOZEN_HIT
      ? [1, 2, 3]
      : entry.betType === SIDE_BET_TYPE.NUMBER_HIT
        ? Array.from({ length: 37 }, (_, i) => i)
        : [0];
  const colors =
    entry.betType === SIDE_BET_TYPE.COLOR_COUNT || entry.betType === SIDE_BET_TYPE.CONSECUTIVE_STREAK
      ? [SIDE_BET_COLOR.RED, SIDE_BET_COLOR.BLACK]
      : [SIDE_BET_COLOR.RED];
  return targets.flatMap((targetNumber) =>
    colors.map((color) => ({
      key: `X100_${entry.key}_${targetNumber}_${color}`,
      betType: entry.betType,
      color,
      targetNumber,
      targetCount: entry.targetCount,
      redRatioBps: 0,
      windowSpins: entry.windowSpins,
      multiplierBps: entry.multiplierBps,
      winProbability: entry.winProbability,
    })),
  );
});

export function buildX100CatalogueForMarket(marketId: number): SideBetCatalogueEntry[] {
  return X100_TEMPLATES.map((template) => ({ ...template, marketId }));
}

/** Fails closed on a pricing regression before any seeding transaction. */
export function assertX100Pricing(): void {
  for (const entry of X100_OFFERS) {
    const wins = BigInt(entry.wins),
      total = BigInt(entry.total);
    const excess = 9500n * total - wins * BigInt(entry.multiplierBps);
    if (excess < 0n || excess * X100_EDGE_TOLERANCE.denominator > X100_EDGE_TOLERANCE.numerator * total * 10000n) {
      throw new Error(`X100 pricing outside 5% target tolerance: ${entry.key}`);
    }
  }
}
