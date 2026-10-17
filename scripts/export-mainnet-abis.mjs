// Export ABI snapshots only after matching every local Solidity source in the artifact build.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names=['RouletteEngine','BankVault4626','BRBJackpotFunder','CreExecutionAuthority','SideBet','TipJar','MarketRegistry','UpkeepScheduler','BRBToken','JackpotTreasury'];
export function checkedArtifact(artifact, build, readSource) {
  if(build.solcVersion!=='0.8.27')throw Error('Expected deployed compiler 0.8.27.');
  for(const [name,source]of Object.entries(build.input.sources)) {
    if(name.startsWith('contracts/') && readSource(name).replaceAll('\r\n','\n')!==source.content.replaceAll('\r\n','\n'))throw Error('Artifact source mismatch: '+name);
  }
  if(!Array.isArray(artifact.abi))throw Error('ABI missing from artifact.');
  const source=artifact.sourceName;
  return {source,sourceSha256:createHash('sha256').update(build.input.sources[source].content.replaceAll('\r\n','\n')).digest('hex'),abi:artifact.abi};
}
export function exportMainnetAbis(artifactRoot, sourceRevision, output) {
  if(!/^[a-f0-9]{40}$/.test(sourceRevision))throw Error('Pin a full source revision.');
  if(existsSync(output))throw Error('Choose a new output file.');
  const bundle={profile:'arbitrum-one-2026-10-15',chainId:42161,sourceRevision,compiler:'0.8.27',contracts:{}};
  for(const name of names){
    const dir=join(resolve(artifactRoot),'contracts',name+'.sol');
    const debug=JSON.parse(readFileSync(join(dir,name+'.dbg.json')));
    const build=JSON.parse(readFileSync(resolve(dir,debug.buildInfo)));
    const artifact=JSON.parse(readFileSync(join(dir,name+'.json')));
    bundle.contracts[name]=checkedArtifact(artifact,build,name=>readFileSync(join(root,name),'utf8'));
  }
  writeFileSync(output,JSON.stringify(bundle,null,2)+'\n');
  return bundle;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [artifacts,revision,output]=process.argv.slice(2);
 if(!artifacts||!revision||!output)throw Error('Usage: export-mainnet-abis.mjs <artifacts-root> <full-source-revision> <new-output-file>');
 exportMainnetAbis(artifacts,revision,output);
 console.log('Exported source-checked ABI snapshot. Runtime identity remains a separate on-chain audit.');
}
