import { funkyProbability } from "./funkyProbability";
import { legacyProbability } from "./sideBetEconomics";
import { windowProbability } from "./windowChallengeProbability";
import { exactChallengeProbability } from "./challengeProbability";

const defaults = { color: 0, targetNumber: 0, targetCount: 0, redRatioBps: 0 };
/** All ten offers, including exact-rule aliases of existing families. No automatic seeding. */
export const FUNKY_CATALOGUE = [
  { ...defaults, key: "CHAMELEON", betType: 5, windowSpins: 4 },
  { ...defaults, key: "COLOR_MIRROR", betType: 16, windowSpins: 4 },
  { ...defaults, key: "ANY_REPEAT", betType: 21, windowSpins: 6 },
  { ...defaults, key: "STRICT_ASCENT", betType: 17, windowSpins: 3 },
  { ...defaults, key: "ZIGZAG", betType: 22, windowSpins: 4 },
  { ...defaults, key: "ANY_DOZEN", betType: 23, windowSpins: 5, targetCount: 3 },
  { ...defaults, key: "COLLECTOR", betType: 9, windowSpins: 5, targetCount: 3 },
  { ...defaults, key: "PHOTO_FINISH", betType: 24, windowSpins: 5, targetNumber: 7 },
  { ...defaults, key: "TWINS", betType: 4, windowSpins: 6, targetNumber: 37, targetCount: 2 },
  { ...defaults, key: "ECLIPSE", betType: 1, windowSpins: 8, targetCount: 1 },
] as const;

export function funkyCataloguePlan(marketId: number, minBand: number, maxBand: number, houseEdgeBps: number) {
  if (!Number.isSafeInteger(marketId) || marketId < 1 || marketId > 0xffffffff || !Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10000 || !Number.isInteger(minBand) || !Number.isInteger(maxBand) || minBand <= 10000 || maxBand < minBand || maxBand > 0xffffffff) throw Error("Invalid pricing inputs");
  return FUNKY_CATALOGUE.map(c => {
    const rule = { ...c, betType: c.key, color: "RED" as const };
    const p = c.betType >= 21 ? funkyProbability(rule) : c.betType === 16 || c.betType === 17 ? windowProbability(rule) : c.betType === 9 ? exactChallengeProbability("PASSPORT", 5, 3) : legacyProbability(c);
    if (!p || p.wins === 0n) throw Error("Unpriceable rule");
    const bps = BigInt(10000 - houseEdgeBps) * p.total / p.wins;
    return { key: c.key, probability: { wins: p.wins.toString(), total: p.total.toString() }, houseEdgeBps, compatible: bps > 10000n && bps >= BigInt(minBand) && bps <= BigInt(maxBand), config: { marketId, betType: c.betType, color: c.color, targetNumber: c.targetNumber, targetCount: c.targetCount, redRatioBps: c.redRatioBps, windowSpins: c.windowSpins, multiplierBps: Number(bps), minStake: 0n, maxStake: 0n } };
  });
}
