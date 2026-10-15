import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X100_OFFERS, assertX100Pricing } from './utils/sideBetX100Catalogue';

assertX100Pricing();
const contents = JSON.stringify(X100_OFFERS, null, 2) + '\n';
const destinations = [
  join(__dirname, '../docs/side-bet-x100-pricing.json'),
  join(__dirname, '../../frontend/lib/side-bet/x100-catalogue.json'),
];
for (const path of destinations) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== contents) throw new Error(`Stale X100 pricing: ${path}`);
  } else writeFileSync(path, contents);
}
