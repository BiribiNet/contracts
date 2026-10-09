import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import coreManifest from '../docs/side-bet-economics-core.json';
import {
  effectiveEdge,
  legacyProbability,
  priceAtFivePercent,
  roundingSafeMinimum,
  LEGACY_TOLERANCE,
  X100_TOLERANCE,
} from '../scripts/utils/sideBetEconomics';
import {
  SIDE_BET_TEMPLATES,
  HISTORICAL_SIDE_BET_TEMPLATES,
  buildCatalogueForMarket,
  toConfigStruct,
} from '../scripts/utils/sideBetCatalogue';
import { buildX100CatalogueForMarket, X100_OFFERS } from '../scripts/utils/sideBetX100Catalogue';
import { supersededConfigIds } from '../scripts/utils/sideBetMigration';

describe('Exact side-bet economics and rounding policy', () => {
  it('matches the cross-repository probability/pricing fingerprint', () => {
    const source = readFileSync(join(__dirname, '../scripts/utils/sideBetEconomics.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(source).digest('hex')).eq(coreManifest.sha256);
  });
  it('matches independent closed forms for the old catalogue', () => {
    const entries = new Map(SIDE_BET_TEMPLATES.map((t) => [t.key, t]));
    const p = (key: string) => legacyProbability(entries.get(key)!)!;
    expect(p('NUMBER_HIT_7_IN_5').wins).eq(37n ** 5n - 36n ** 5n);
    expect(p('LIGHTNING_DOUBLE_ANY_IN_6').wins).eq(37n ** 6n - 37n * 36n ** 5n);
    expect(p('COLOR_COUNT_RED_5_IN_6').wins).eq(6n * 18n ** 5n * 19n + 18n ** 6n);
    expect(p('JACKPOT_IN_3').wins).eq(37n ** 3n - 36n ** 3n);
    expect(p('PERFECT_ALTERNATION_5').wins).eq(2n * 18n ** 5n);
    expect(p('DOZEN_HIT_1_FIVE_IN_6').wins).eq(6n * 12n ** 5n * 25n + 12n ** 6n);
    expect(p('COLUMN_HIT_2_SIX_IN_8').wins).eq(28n * 12n ** 6n * 25n ** 2n + 8n * 12n ** 7n * 25n + 12n ** 8n);
    expect(p('RED_RATIO_80_IN_10').wins).eq(45n * 18n ** 8n * 19n ** 2n + 10n * 18n ** 9n * 19n + 18n ** 10n);
    // A run of five in eight can start at 0, or at 1..3 with a preceding non-black.
    expect(p('CONSECUTIVE_STREAK_BLACK_5_IN_8').wins).eq(18n ** 5n * 37n ** 3n + 3n * 19n * 18n ** 5n * 37n ** 2n);
  });
  it('preserves old rules and chooses the largest multiplier that never undercuts 5%', () => {
    SIDE_BET_TEMPLATES.forEach((entry, index) => {
      const { multiplierBps, winProbability, ...rules } = entry;
      const { multiplierBps: oldPrice, winProbability: oldChance, ...oldRules } = HISTORICAL_SIDE_BET_TEMPLATES[index];
      expect(rules).deep.eq(oldRules);
      const p = legacyProbability(entry)!;
      expect(multiplierBps).eq(priceAtFivePercent(p));
      expect(p.wins * BigInt(multiplierBps) <= 9500n * p.total).eq(true);
      expect(p.wins * BigInt(multiplierBps + 1) > 9500n * p.total).eq(true);
    });
  });
  it('independently matches all X100 counts', () => {
    for (const offer of X100_OFFERS) {
      const entry = buildX100CatalogueForMarket(1).find((c) => c.betType === offer.betType)!;
      expect(legacyProbability(entry)).deep.eq({ wins: BigInt(offer.wins), total: BigInt(offer.total) });
    }
  });
  for (const [catalogue, tolerance] of [
    [SIDE_BET_TEMPLATES, LEGACY_TOLERANCE],
    [buildX100CatalogueForMarket(1), X100_TOLERANCE],
  ] as const)
    it(`bounds token rounding for all stakes above the ${tolerance.denominator} policy floor`, () => {
      for (const entry of catalogue.filter(
        (entry, index, all) => all.findIndex((other) => other.multiplierBps === entry.multiplierBps) === index,
      )) {
        const p = legacyProbability(entry)!;
        const min = roundingSafeMinimum(p, entry.multiplierBps, tolerance)!;
        expect(min > 1n).eq(true);
        // Verify every residue of stake*m mod 10000, at the smallest permitted stake with that residue.
        for (let offset = 0n; offset < 10000n; offset++) {
          const edge = effectiveEdge(p, entry.multiplierBps, min + offset)!;
          if (
            edge.numerator * 20n < edge.denominator ||
            (edge.numerator * 20n - edge.denominator) * tolerance.denominator >
              20n * edge.denominator * tolerance.numerator
          )
            throw new Error(`Unbounded edge: ${entry.key}, stake=${min + offset}`);
        }
      }
    });
  it('rejects odds that cannot meet the tolerance and malformed rules', () => {
    const p = { wins: 1n, total: 100n };
    expect(roundingSafeMinimum(p, 1000000)).eq(null); // zero edge
    expect(roundingSafeMinimum(p, 900000)).eq(null); // 10% edge
    expect(legacyProbability({ ...SIDE_BET_TEMPLATES[0], targetNumber: 37 })).eq(null);
    expect(legacyProbability({ ...SIDE_BET_TEMPLATES[0], windowSpins: 65 })).eq(null);
    expect(effectiveEdge(p, 950000, 0n)).eq(null);
  });
  it('retires only identical historical prices in the same market and is rerunnable', () => {
    const [replacement] = buildCatalogueForMarket(1);
    const old = { ...HISTORICAL_SIDE_BET_TEMPLATES[0], marketId: 1 };
    const configs = new Map([
      [0, toConfigStruct(old)],
      [1, toConfigStruct(replacement)],
      [2, toConfigStruct({ ...old, marketId: 2 })],
      [3, toConfigStruct({ ...old, multiplierBps: old.multiplierBps + 1 })],
    ]);
    expect(supersededConfigIds(replacement, configs)).deep.eq([0]);
    configs.delete(0);
    expect(supersededConfigIds(replacement, configs)).deep.eq([]);
  });
});
