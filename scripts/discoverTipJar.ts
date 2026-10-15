import { vars } from 'hardhat/config';
import { ethers, artifacts } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
async function main() {
  const audit = JSON.parse(readFileSync('deployments/live-audit-2026-10-09.json','utf8'));
  const url = new URL('https://api.etherscan.io/v2/api');
  Object.entries({chainid:'421614',module:'account',action:'txlist',address:audit.signer,startblock:'0',endblock:'9999999999',page:'1',offset:'10000',sort:'asc',apikey:vars.get('ETHERSCAN_API_KEY')}).forEach(([k,v])=>url.searchParams.set(k,v));
  const transactions: any[] = [];
  for (let page=1;page<=20;page++) {
    url.searchParams.set('offset','1000'); url.searchParams.set('page',String(page));
    const response = await fetch(url).then(r=>r.json());
    if (response.status !== '1') {
      if (response.message === 'No transactions found') break;
      throw new Error(String(response.result));
    }
    transactions.push(...response.result);
    if (response.result.length < 1000) break;
    if (page===20) throw new Error('History truncated');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const artifact = await artifacts.readArtifact('TipJar');
  const matches = transactions.filter((tx:any)=>tx.to==='' && tx.input.toLowerCase().startsWith(artifact.bytecode.toLowerCase()));
  const result = {signer:audit.signer, inspectedTransactions:transactions.length, matchedDeployments:matches.map((tx:any)=>({address:tx.contractAddress, hash:tx.hash, block:tx.blockNumber}))};
  writeFileSync('deployments/tip-jar-discovery-2026-10-09.json',JSON.stringify(result,null,2)+'\n');
  console.log(result);
  if (matches.length) throw new Error('Existing TipJar deployment discovered');
}
main().catch(()=>{console.error('TipJar discovery failed; inspect saved result if present');process.exitCode=1;});
