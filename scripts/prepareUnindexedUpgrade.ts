import { vars } from 'hardhat/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const preflight = JSON.parse(readFileSync('deployments/unindexed-preflight-2026-10-15.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json', 'utf8'));
  const folder = 'deployments/unindexed-upgrade-2026-10-15';
  mkdirSync(folder, { recursive: true });
  const names = ['RouletteEngine', 'BankVault4626', 'BRBJackpotFunder', 'CreExecutionAuthority', 'AutomationReceiver'];
  const addresses = names.map(name => [name, preflight.rows.find((r: any) => r.name === name).address]);
  addresses.push(['TipJar', manifest.addresses.tipJar]);
  if (existsSync(`${folder}/live-state.json`)) {
    const state = JSON.parse(readFileSync(`${folder}/live-state.json`, 'utf8'));
    addresses.find(([name]) => name === 'BRBJackpotFunder')![1] = state.funder.address;
  }
  for (const [name, address] of addresses) {
    const url = new URL('https://api.etherscan.io/v2/api');
    for (const [key, value] of Object.entries({ chainid: '421614', module: 'contract', action: 'getsourcecode', address, apikey: vars.get('ETHERSCAN_API_KEY') })) url.searchParams.set(key, value);
    let response: any;
    try { response = await fetch(url).then(r => r.json()); } catch { throw new Error(`Explorer request failed for ${name}`); }
    if (response.status !== '1' || !response.result?.[0]?.SourceCode) throw new Error(`Verified source unavailable for ${name}`);
    const source = response.result[0];
    writeFileSync(join(folder, `${name}-verified.json`), JSON.stringify({ address, ...source }, null, 2) + '\n');
    const raw = source.SourceCode;
    const input = JSON.parse(raw.startsWith('{{') ? raw.slice(1, -1) : raw);
    let indexedParameters = 0;
    const changedSources: string[] = [];
    for (const [path, value] of Object.entries(input.sources) as [string, any][]) {
      // Protocol sources only; keep dependency event standards intact.
      if (!path.startsWith('contracts/') || path.startsWith('contracts/vendor/')) continue;
      const matches = value.content.match(/\bindexed\b/g) ?? [];
      if (!matches.length) continue;
      indexedParameters += matches.length;
      changedSources.push(path);
      value.content = value.content.replace(/\bindexed\s+/g, '');
    }
    input.settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'storageLayout'], '': ['ast'] } };
    writeFileSync(join(folder, `${name}-candidate-input.json`), JSON.stringify(input) + '\n');
    console.log(JSON.stringify({ name, address, compiler: source.CompilerVersion, indexedParameters, changedSources }));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
