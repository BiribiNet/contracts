import { vars } from 'hardhat/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
async function main() {
  const report = JSON.parse(readFileSync('deployments/live-audit-2026-10-09.json', 'utf8'));
  mkdirSync('deployments/verified-sources', { recursive: true });
  for (const row of report.rows.filter((r: any) => !r.matches)) {
    if (require('node:fs').existsSync(`deployments/verified-sources/${row.name}.json`)) continue;
    await new Promise(resolve => setTimeout(resolve, 500));
    const url = new URL('https://api.etherscan.io/v2/api');
    Object.entries({ chainid: '421614', module: 'contract', action: 'getsourcecode', address: row.address, apikey: vars.get('ETHERSCAN_API_KEY') }).forEach(([k,v]) => url.searchParams.set(k,v));
    const response = await fetch(url).then(r => r.json());
    if (response.status !== '1') { console.log(row.name, 'source unavailable', response.result); continue; }
    const data = response.result[0];
    writeFileSync(`deployments/verified-sources/${row.name}.json`, JSON.stringify(data, null, 2));
    console.log(row.name, data.ContractName, data.CompilerVersion, 'source chars', data.SourceCode.length);
  }
}
main().catch(() => { console.error('Source retrieval failed'); process.exitCode = 1; });
