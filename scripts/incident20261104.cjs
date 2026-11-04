#!/usr/bin/env node
// Fork ONLY: compile, test, validate layouts, recover and remove recovery functions through upgrades.
// There is deliberately no broadcast mode and no mainnet signer in this script.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'reports/incident-2026-11-04');
const CONFIG = path.join(ROOT, 'hardhat.incident.config.ts');
const json = x => JSON.stringify(x, (_k,v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
const save = (name, x) => { fs.mkdirSync(DIR,{recursive:true}); fs.writeFileSync(path.join(DIR,name), json(x)); };
const clone = x => JSON.parse(JSON.stringify(x));

function archiveRpc() {
  if(process.env.INCIDENT_FORK_URL)return process.env.INCIDENT_FORK_URL;
  require('ts-node/register');process.env.HARDHAT_CONFIG=CONFIG;require('hardhat');
  const {vars}=require('hardhat/config');
  return vars.has('ARBITRUM_RPC_URL')?vars.get('ARBITRUM_RPC_URL'):'https://arbitrum-one.public.blastapi.io';
}

function compiler() {
  if(process.env.INCIDENT_SOLC) {
    assert(fs.existsSync(process.env.INCIDENT_SOLC),'INCIDENT_SOLC does not exist');
    return process.env.INCIDENT_SOLC;
  }
  const {CompilerDownloader}=require('hardhat/internal/solidity/compiler/downloader');
  const platform=CompilerDownloader.getCompilerPlatform();
  const dir=path.join(require('env-paths')('hardhat').cache,'compilers-v2',platform);
  const list=path.join(dir,'list.json');
  assert(fs.existsSync(list),'Compile with Hardhat once or provide INCIDENT_SOLC (native solc 0.8.27)');
  const build=JSON.parse(fs.readFileSync(list)).builds.find(b=>b.longVersion==='0.8.27+commit.40a35a09');
  assert(build,'Native solc 0.8.27 not found');const file=path.join(dir,build.path);
  assert(fs.existsSync(file),'Native compiler missing; provide INCIDENT_SOLC');return file;
}
function solc(input) {
  const r = spawnSync(compiler(),['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(r.status,0,'Solc process failed');
  const out = JSON.parse(r.stdout);
  const errors=(out.errors||[]).filter(e=>e.severity==='error');
  assert.equal(errors.length,0,errors.map(e=>e.formattedMessage).join('\n'));
  return out;
}
function layouts(input,name) {
  input=clone(input); const probe='IncidentStorageProbe.sol';
  const type=name==='BankVault4626'?'BankVault4626.BankVaultStorage':'SideBet.SideBetData';
  input.sources[probe]={content:`pragma solidity ^0.8.27; import "contracts/${name}.sol"; contract IncidentStorageProbe { ${type} internal data; }`};
  input.settings.outputSelection={'*':{'*':['storageLayout']}};
  const out=solc(input), p=out.contracts[probe].IncidentStorageProbe.storageLayout;
  const custom={...p,storage:p.types[p.storage[0].type].members};
  return {custom,ordinary:out.contracts['contracts/'+name+'.sol'][name].storageLayout};
}
function compareLayout(before,after) {
  const seen=new Set();
  function members(a,b,label) {
    assert(b.length>=a.length,label+' removed fields');
    for(let i=0;i<a.length;i++) {
      for(const k of ['label','slot','offset']) assert.equal(b[i][k],a[i][k],label+' '+k);
      types(a[i].type,b[i].type,label+'.'+a[i].label);
    }
  }
  function types(aid,bid,label,fixed=false) {
    const key=aid+bid+fixed; if(seen.has(key))return;seen.add(key);
    const a=before.types[aid],b=after.types[bid];
    assert(a&&b,label+' missing type');assert.equal(b.encoding,a.encoding,label+' encoding');
    if(fixed||!a.members)assert.equal(b.numberOfBytes,a.numberOfBytes,label+' width/stride');
    if(a.members)members(a.members,b.members,label);
    else if(a.encoding==='mapping') {types(a.key,b.key,label+' key');types(a.value,b.value,label+' value');}
    else if(a.base)types(a.base,b.base,label+' item',true);
    else assert.equal(b.label.replace(/\s+/g,' '),a.label.replace(/\s+/g,' '),label+' type');
  }
  members(before.storage,after.storage,'storage');
}
function prepareValidation() {
  const storage=[],sizes=[],recovery={},future={};
  for(const name of ['BankVault4626','SideBet']) {
    const sourcePath='contracts/'+name+'.sol';
    const input=JSON.parse(fs.readFileSync(path.join(DIR,'compiler-inputs',name+'-recovery.json')));
    const clean=JSON.parse(fs.readFileSync(path.join(DIR,'compiler-inputs',name+'-clean.json')));
    // Production sources stay on the final implementation. Historical recovery code is immutable input.
    for(const [p,source] of Object.entries(clean.sources)) {
      const local=path.join(ROOT,p.startsWith('contracts/')?p:'node_modules/'+p);
      assert.equal(fs.readFileSync(local,'utf8'),source.content,'Source differs from the completed release: '+p);
    }
    const original=JSON.parse(fs.readFileSync(path.join(DIR,'verified-inputs',name+'.json')));
    const namespace=/STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/;
    const originalRoot=original.sources[sourcePath].content.match(namespace)?.[1];
    assert(originalRoot,'Missing deployed storage namespace');
    assert.equal(input.sources[sourcePath].content.match(namespace)?.[1],originalRoot,'Namespace root changed');
    assert.equal(clean.sources[sourcePath].content.match(namespace)?.[1],originalRoot,'Cleanup namespace root changed');
    const old=layouts(original,name),now=layouts(input,name),later=layouts(clean,name);
    for(const section of ['custom','ordinary']) {compareLayout(old[section],now[section]);compareLayout(now[section],later[section]);}
    storage.push({name,compatible:true,fieldsBefore:old.custom.storage.length,fieldsNow:now.custom.storage.length,
      fieldsAfterRecoveryRemoval:later.custom.storage.length,layouts:{deployed:old,current:now,afterRemoval:later}});
    for(const [revision,saved,target] of [['recovery',input,recovery],['after-removal',clean,future]]) {
      const compiling=clone(saved);
      compiling.settings.outputSelection={[sourcePath]:{[name]:['abi','evm.bytecode','evm.deployedBytecode']}};
      const compiled=solc(compiling).contracts[sourcePath][name];
      const artifact={abi:compiled.abi,bytecode:'0x'+compiled.evm.bytecode.object,deployedBytecode:'0x'+compiled.evm.deployedBytecode.object};
      target[name]=artifact;
      const row={name,revision,runtimeBytes:(artifact.deployedBytecode.length-2)/2,initcodeBytes:(artifact.bytecode.length-2)/2};
      assert(row.runtimeBytes<=24576,'EIP-170 exceeded: '+name+' '+revision);
      assert(row.initcodeBytes<=49152,'EIP-3860 exceeded: '+name+' '+revision);sizes.push(row);
      if(revision==='after-removal') {
        const current=JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts/contracts',name+'.sol',name+'.json')));
        assert.equal(current.bytecode,artifact.bytecode,'Current compilation differs from deployed cleanup: '+name);
        assert(!artifact.abi.some(row=>row.type==='function'&&row.name.startsWith('recoverNovember2026')),'Recovery leaked into production ABI');
      }
    }
  }
  const executed=JSON.parse(fs.readFileSync(path.join(DIR,'mainnet-execution-2026-11-04T18-59-44-816Z.json')));
  const {keccak256}=require('ethers');
  for(const [key,artifact] of Object.entries({recoveryBank:recovery.BankVault4626,recoverySide:recovery.SideBet,cleanBank:future.BankVault4626,cleanSide:future.SideBet})) {
    assert.equal(keccak256(artifact.bytecode),executed.artifactHashes[key],key+' differs from executed mainnet bytecode');
  }
  save('storage-validation.json',{reference:'Explorer-verified deployed standard JSON inputs',contracts:storage});
  save('bytecode-sizes.json',sizes);save('recovery-artifacts.json',recovery);save('future-upgrade-artifacts.json',future);
  console.log('Validated archived recovery, production cleanup sources, executed bytecodes, storage and size limits.');
}

async function orchestrate() {
  assert(process.argv.slice(2).every(arg=>arg==='--fork'),'FORK ONLY. Use the production entry point explicitly for mainnet.');
  const result=spawnSync(process.execPath,[path.join(ROOT,'scripts/incident20261104-mainnet.cjs'),'--fork'],{cwd:ROOT,env:process.env,stdio:'inherit'});
  assert.equal(result.status,0,'Fork rehearsal failed');
}
async function readRelay() {
  const http=require('node:http');
  const upstream=archiveRpc();
  const allowed=new Set(['eth_chainId','net_version','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
    'eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getTransactionByHash',
    'eth_getTransactionReceipt','eth_getLogs','eth_call','eth_getProof']);
  const cache=new Map();let tail=Promise.resolve(),reads=0,lastMethod=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function read(q) {
    if(!allowed.has(q.method))return {jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Read-only archive relay'}};
    const params=q.params||[],key=JSON.stringify([q.method,params]);
    const stable=!['eth_blockNumber','eth_chainId','net_version'].includes(q.method)&&!params.includes('latest')&&!params.includes('pending');
    if(stable&&cache.has(key))return {...cache.get(key),id:q.id};
    const job=tail.then(async()=>{
      if(stable&&cache.has(key))return {...cache.get(key),id:q.id};
      let last;
      for(let attempt=0;attempt<4;attempt++) {
        await sleep(attempt?Math.min(3000,500*2**attempt):75);
        try {
          lastMethod=q.method;
          const response=await fetch(upstream,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q),signal:AbortSignal.timeout(10_000)});
          const body=await response.json();last=body;
          ++reads;if(reads%50===0)console.error('Read-only archive relay: '+reads+' reads completed.');
          if(response.status===429||response.status>=500||/rate|limit|busy/i.test(body.error?.message||''))continue;
          if(stable&&!body.error)cache.set(key,body);return {...body,id:q.id};
        } catch {last={jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'Archive read failed'}};}
      }
      return {...last,id:q.id};
    });
    tail=job.then(()=>{},()=>{});return job;
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({readOnly:true,reads,lastMethod,cacheEntries:cache.size}));return;}
      let input='';for await(const chunk of req){input+=chunk;if(input.length>1_000_000)throw Error('Large RPC body');}
      const q=JSON.parse(input),out=Array.isArray(q)?await Promise.all(q.map(read)):await read(q);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(out));
    }catch{res.writeHead(400);res.end('Invalid read-only RPC request');}
  });
  server.listen(0,'127.0.0.1',()=>process.send({url:'http://127.0.0.1:'+server.address().port}));
}
module.exports={prepareValidation,archiveRpc,compiler};
if(require.main===module) {
  const task=process.env.INCIDENT_20261104_READ_RELAY==='1'?readRelay:orchestrate;
  task().catch(e=>{console.error(String(e.shortMessage||e.message).replace(/https?:\/\/\S+/g,'[RPC]').slice(0,1800));process.exitCode=1;});
}
