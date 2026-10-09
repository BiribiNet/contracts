import { SIDE_BET_TEMPLATES } from './utils/sideBetCatalogue';
import { simulateSideBetEconomics } from './utils/sideBetEconomics';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const scenarios = [['USDC', 6], ['DAI', 18], ['BRB', 18]] as const;
const x100 = JSON.parse(readFileSync(resolve(__dirname, 'utils/x100-economics.json'), 'utf8')) as {key:string; wins:string; total:string; multiplierBps:number}[];
const offers = [...SIDE_BET_TEMPLATES.map(x => ({...x, probabilitySource:'sampled legacy catalogue'})), ...x100.map(x => ({key:x.key, winProbability:Number(BigInt(x.wins))/Number(BigInt(x.total)), multiplierBps:x.multiplierBps, probabilitySource:'exact X100 manifest'}))];
const result = { model: 'Independent tickets; no expiry, gas, roulette exposure or price conversion. Correlation stress is separate.',
  seed: 9127, tickets: 10000, fees: '300 funding + 200 infrastructure bps; the funding input is not BRB output.',
  scenarios: scenarios.flatMap(([asset, decimals]) => offers.map(offer => ({
    asset, decimals, offer: offer.key, probabilitySource: offer.probabilitySource,
    ...simulateSideBetEconomics({ probability: offer.winProbability, multiplierBps: offer.multiplierBps,
      stake: 10n ** BigInt(decimals), tickets: 10000, feeBps: 500n, seed: 9127 })
  }))) };
const output = resolve(process.env.ECONOMICS_OUTPUT ?? 'reports/sidebet-economics.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(`Wrote ${result.scenarios.length} scenarios to ${output}. No transactions sent.`);
