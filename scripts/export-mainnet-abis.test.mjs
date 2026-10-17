import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedArtifact } from './export-mainnet-abis.mjs';
const artifact={sourceName:'contracts/Vault.sol',abi:[{type:'event',name:'WithdrawalProcessed',inputs:[]}]};
const build={solcVersion:'0.8.27',input:{sources:{'contracts/Vault.sol':{content:'contract Vault {}\n'},'contracts/Library.sol':{content:'library Library {}\n'}}}};
const source=name=>build.input.sources[name].content;
test('matches root and imported Solidity source, normalizing only line endings',()=>{
 const result=checkedArtifact(artifact,build,name=>source(name).replaceAll('\n','\r\n'));
 assert.equal(result.source,artifact.sourceName);assert.match(result.sourceSha256,/^[0-9a-f]{64}$/);assert.deepEqual(result.abi,artifact.abi);
});
test('rejects changed imports, unknown compiler and missing ABI',()=>{
 assert.throws(()=>checkedArtifact(artifact,build,name=>name.includes('Library')?'different':source(name)),/mismatch/);
 assert.throws(()=>checkedArtifact(artifact,{...build,solcVersion:'0.8.28'},source),/compiler/);
 assert.throws(()=>checkedArtifact({...artifact,abi:undefined},build,source),/ABI/);
});
