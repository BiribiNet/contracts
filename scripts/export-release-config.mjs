// Public configuration only. No provider calls, credential reads, deployment or hosting changes.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [manifestFile, environment, outputDirectory] = process.argv.slice(2);
if (!manifestFile || !['mainnet', 'testnet'].includes(environment) || !outputDirectory) throw new Error('Usage: export-release-config.mjs <manifest> <mainnet|testnet> <new-output-directory>');
const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
const chainId = environment === 'mainnet' ? 42161 : 421614;
if (environment === 'mainnet' && manifest.chainId !== chainId) throw new Error('Mainnet requires an explicit chainId 42161 manifest.');
if (manifest.chainId && manifest.chainId !== chainId) throw new Error('Manifest chain mismatch');
manifest.chainId = chainId;
const valid = value => /^0x[\da-f]{40}$/i.test(value ?? '') && !/^0x0{40}$/i.test(value);
const values = {};
for (const [env, key] of Object.entries({ ROULETTE_ENGINE: 'roulette', BRB_TOKEN: 'brb', UPKEEP_SCHEDULER: 'scheduler',
  MARKET_REGISTRY: 'registry', SIDE_BET: 'sideBet', JACKPOT_TREASURY: 'jackpotTreasury', JACKPOT_FUNDER: 'jackpotFunder',
  BRBR_TOKEN: 'brbReferal', AUTOMATION_RECEIVER: 'automationReceiver', CRE_EXECUTION_AUTHORITY: 'creExecutionAuthority' })) {
  if (!valid(manifest.addresses?.[key])) throw new Error(`Invalid/missing addresses.${key}`);
  values[`NEXT_PUBLIC_${env}_ADDRESS`] = manifest.addresses[key];
}
if (!valid(manifest.markets?.usdc?.bank) || !valid(manifest.vrf?.coordinator)) throw new Error('Missing default bank or coordinator');
Object.assign(values, {
  NEXT_PUBLIC_DEFAULT_BANK_ADDRESS: manifest.markets.usdc.bank,
  NEXT_PUBLIC_VRF_COORDINATOR_ADDRESS: manifest.vrf.coordinator,
  NEXT_PUBLIC_CHAIN_ENV: environment,
  NEXT_PUBLIC_SITE_URL: environment === 'mainnet' ? 'https://biribi.net' : 'https://testnet.biribi.net',
  NEXT_PUBLIC_SUBGRAPH_URL: '/api/subgraph',
  NEXT_PUBLIC_RPC_URL: environment === 'mainnet' ? 'https://arb1.arbitrum.io/rpc' : 'https://sepolia-rollup.arbitrum.io/rpc',
  NEXT_PUBLIC_TX_EXPLORER_URL: environment === 'mainnet' ? 'https://arbiscan.io/tx/' : 'https://sepolia.arbiscan.io/tx/',
  NEXT_PUBLIC_DISABLE_INDEXING: environment === 'mainnet' ? 'false' : 'true',
});
const out = resolve(outputDirectory);
if (existsSync(out)) throw new Error('Output exists; choose a fresh release directory');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'frontend.public.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
writeFileSync(join(out, 'frontend.deployment.json'), JSON.stringify(manifest, null, 2) + '\n');
const subgraph = environment === 'mainnet' ? 'biribi-arbitrum-one' : 'biribi';
writeFileSync(join(out, 'server.env.example'), `# Populate through Vercel; never commit real secrets. Separate service credentials per environment.\nSUBGRAPH_API_URL=https://api.goldsky.com/api/private/project_cmfbfxud380il01v04gey3ym6/subgraphs/${subgraph}/prod/gn\nNEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=\nGOLDSKY_API_TOKEN=\nABLY_API_KEY=\nMIRROR_API_SECRET=\nCRON_SECRET=\nSECURITY_REDIS_REST_URL=\nSECURITY_REDIS_REST_TOKEN=\n# Keep GTM off on mainnet until container code and publishing access are reviewed.\nGTM_SECURITY_REVIEWED=false\nBOT_PAUSED=true\nBOT_DUAL_GAME_ENABLED=false\nBIRIBI_RELEASE_CHECK=1\nBIRIBI_DEPLOYMENT_MANIFEST=deployments/${environment === 'mainnet' ? 'arbitrum-one' : 'arbitrum-sepolia'}.json\n`);
console.log(`Exported public ${environment} configuration to ${out}; service credentials still require configuration.`);
