import {
  HISTORICAL_SIDE_BET_TEMPLATES,
  matchesConfig,
  type SideBetCatalogueEntry,
  type SideBetConfigStruct,
} from './sideBetCatalogue';
/** Retire only known historical prices with identical rules, never custom offers. */
export function supersededConfigIds(
  entry: SideBetCatalogueEntry,
  existing: Map<number, SideBetConfigStruct>,
): number[] {
  const historical = HISTORICAL_SIDE_BET_TEMPLATES.find((t) => t.key === entry.key);
  if (!historical || historical.multiplierBps === entry.multiplierBps) return [];
  return [...existing]
    .filter(([, config]) => matchesConfig({ ...historical, marketId: entry.marketId }, config))
    .map(([id]) => id);
}
