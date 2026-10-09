/** Exact counts on a uniform 37-pocket wheel. Shared verbatim with the frontend. */
export interface Probability {
  wins: bigint;
  total: bigint;
}
export interface LegacyRules {
  betType: number;
  windowSpins: number;
  targetCount: number;
  targetNumber: number;
  redRatioBps: number;
  color: number;
}
function tail(n: number, k: number, pockets: number): Probability {
  let combination = 1n,
    wins = 0n;
  for (let i = 0; i <= n; i++) {
    if (i >= k) wins += combination * BigInt(pockets) ** BigInt(i) * BigInt(37 - pockets) ** BigInt(n - i);
    combination = (combination * BigInt(n - i)) / BigInt(i + 1);
  }
  return { wins, total: 37n ** BigInt(n) };
}
function run(n: number, k: number, pockets: number, anyNumber = false): Probability {
  let states = Array<bigint>(k).fill(0n),
    wins = 0n;
  states[0] = 1n;
  for (let i = 0; i < n; i++) {
    const next = Array<bigint>(k).fill(0n);
    wins *= 37n;
    for (let j = 0; j < k; j++) {
      if (anyNumber && i === 0) {
        next[1] += states[j] * 37n;
        continue;
      }
      next[anyNumber ? 1 : 0] += states[j] * BigInt(37 - pockets);
      if (j + 1 === k) wins += states[j] * BigInt(pockets);
      else next[j + 1] += states[j] * BigInt(pockets);
    }
    states = next;
  }
  return { wins, total: 37n ** BigInt(n) };
}
/** Unsupported or malformed configurations stay unknown. */
export function legacyProbability(c: LegacyRules): Probability | null {
  const n = c.windowSpins,
    k = c.targetCount;
  if (
    ![c.betType, n, k, c.targetNumber, c.redRatioBps, c.color].every(Number.isInteger) ||
    n < 1 ||
    n > 64 ||
    ![0, 1].includes(c.color)
  )
    return null;
  const targetValid = k >= 1 && k <= n;
  switch (c.betType) {
    case 0:
      return targetValid ? tail(n, k, 18) : null;
    case 1:
      return targetValid && c.targetNumber >= 0 && c.targetNumber <= 36 ? tail(n, k, 1) : null;
    case 2:
      return targetValid ? run(n, k, 18) : null;
    case 3:
      return c.redRatioBps > 0 && c.redRatioBps <= 10000 ? tail(n, Math.ceil((c.redRatioBps * n) / 10000), 18) : null;
    case 4:
      return targetValid && k >= 2 && c.targetNumber >= 0 && c.targetNumber <= 37
        ? run(n, k, 1, c.targetNumber === 37)
        : null;
    case 5:
      return n >= 2 ? { wins: 2n * 18n ** BigInt(n), total: 37n ** BigInt(n) } : null;
    case 6:
    case 7:
      return targetValid && [1, 2, 3].includes(c.targetNumber) ? tail(n, k, 12) : null;
    case 8:
      return tail(n, 1, 1);
    default:
      return null;
  }
}
export const LEGACY_TOLERANCE = { numerator: 2n, denominator: 100_000n };
export const X100_TOLERANCE = { numerator: 2n, denominator: 1_000_000n };
export function priceAtFivePercent(p: Probability): number {
  if (p.wins <= 0n || p.total < p.wins) throw new Error('Invalid probability');
  return Number((9500n * p.total) / p.wins);
}
/** Guarantee the effective edge for EVERY raw stake at/above this floor, including payout truncation.
 * Returns null when the quoted odds cannot meet the tolerance regardless of stake. */
export function roundingSafeMinimum(
  p: Probability,
  multiplierBps: number,
  tolerance = LEGACY_TOLERANCE,
): bigint | null {
  if (!Number.isSafeInteger(multiplierBps) || multiplierBps <= 0 || p.wins <= 0n || p.total < p.wins) return null;
  const excess = 9500n * p.total - p.wins * BigInt(multiplierBps);
  const budget = 10000n * p.total * tolerance.numerator - excess * tolerance.denominator;
  if (excess < 0n || budget <= 0n) return null;
  // floor(x) loses strictly less than one indivisible token unit.
  const numerator = p.wins * 10000n * tolerance.denominator;
  return (numerator + budget - 1n) / budget;
}
export function effectiveEdge(
  p: Probability,
  multiplierBps: number,
  stake: bigint,
): { numerator: bigint; denominator: bigint } | null {
  if (stake <= 0n || !Number.isSafeInteger(multiplierBps) || multiplierBps <= 0) return null;
  return {
    numerator: stake * p.total - p.wins * ((stake * BigInt(multiplierBps)) / 10000n),
    denominator: stake * p.total,
  };
}
