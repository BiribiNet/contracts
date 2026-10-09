import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIDE_BET_TEMPLATES, HISTORICAL_SIDE_BET_TEMPLATES } from './utils/sideBetCatalogue';
import { legacyProbability, roundingSafeMinimum, LEGACY_TOLERANCE } from './utils/sideBetEconomics';
const rows = SIDE_BET_TEMPLATES.map((entry, index) => {
  const probability = legacyProbability(entry)!;
  return {
    ...entry,
    previousMultiplierBps: HISTORICAL_SIDE_BET_TEMPLATES[index].multiplierBps,
    wins: probability.wins.toString(),
    total: probability.total.toString(),
    theoreticalEdgeNumerator: (10000n * probability.total - BigInt(entry.multiplierBps) * probability.wins).toString(),
    theoreticalEdgeDenominator: (10000n * probability.total).toString(),
    roundingSafeMinimumRaw: roundingSafeMinimum(probability, entry.multiplierBps, LEGACY_TOLERANCE)!.toString(),
  };
});
writeFileSync(join(__dirname, '../docs/side-bet-legacy-pricing.json'), JSON.stringify(rows, null, 2) + '\n');
