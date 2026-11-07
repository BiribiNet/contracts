#!/usr/bin/env node
// Reproducible proof that `reports/vault-2026-11-05/BankVault4626.sol` is the source of the BankVault4626
// implementation installed on Arbitrum One on 2026-11-05 (0x6e84c0ED4056bA6E94dFF5008aBE811738f8f3cC).
// Read-only: no wallet, and the provider refuses every signing/sending method.
//
//   node scripts/verifyVault20261105.cjs              # compile + compare with eth_getCode (ARBITRUM_RPC_URL or public RPC)
//   node scripts/verifyVault20261105.cjs --offline    # compare with the archived runtime (no network)
//   node scripts/verifyVault20261105.cjs --write      # also rewrite compiler-input.json, abi.json, match.json (+ runtime)
//
// Compiler: native solc 0.8.27 (Hardhat cache, or INCIDENT_SOLC), the settings of the incident inputs
// (optimizer runs 1, viaIR false, cancun, bytecodeHash none) — the same as every mainnet vault implementation.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {JsonRpcProvider,keccak256,id}=require('ethers');
const {compiler}=require('./incident20261104.cjs');
const C=require('./mask-bets-v1-common.cjs');

const ROOT=path.resolve(__dirname,'..');
const DIR=path.join(ROOT,'reports/vault-2026-11-05');
const IMPLEMENTATION='0x6e84c0ED4056bA6E94dFF5008aBE811738f8f3cC';
const PREVIOUS='0x129cAf686c2489685841Ef1E9d442Fd8b963797D';
const SOURCE_PATH='contracts/BankVault4626.sol';
const BASE_INPUT='reports/incident-2026-11-04/compiler-inputs/BankVault4626-clean.json';
const RUNTIME_FILE=path.join(DIR,'onchain-runtime-0x6e84c0ed.hex');
/**
 * Two identifiers of 0x6e84 could not be recovered: only their keccak is on chain (an error selector and an event
 * topic), and a dictionary search of the plausible names found no preimage. The reconstructed source gives them
 * descriptive names; the proof substitutes exactly these two constants and must then match byte for byte.
 */
const UNRESOLVED_NAMES=[
  {kind:'error',signature:'SharesLockedByPendingWithdrawal()',onChain:'e3ee11df'},
  {kind:'event',signature:'SkippedWithdrawalFeeCharged(uint256,address,address,uint256,uint256)',
    onChain:'debd20cf867e0067bf5d9e8539b5223bb556e27981cc7caca1dde99676f2c7bf'},
];

/** Standard-JSON input: the clean incident input (same settings and dependency sources) with the reconstructed vault. */
function buildInput() {
  const input=JSON.parse(fs.readFileSync(path.join(ROOT,BASE_INPUT),'utf8'));
  input.sources[SOURCE_PATH]={content:fs.readFileSync(path.join(DIR,'BankVault4626.sol'),'utf8')};
  input.settings.outputSelection={[SOURCE_PATH]:{BankVault4626:['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.methodIdentifiers']}};
  return input;
}
function compile(input) {
  const run=spawnSync(compiler(),['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(run.status,0,'solc failed');
  const out=JSON.parse(run.stdout);
  const errors=(out.errors||[]).filter(e=>e.severity==='error');
  assert.equal(errors.length,0,errors.map(e=>e.formattedMessage).join('\n'));
  return out.contracts[SOURCE_PATH].BankVault4626;
}
/**
 * ERC-7201 layout of the reconstructed vault, by the probe method of `reports/incident-2026-11-04/storage-validation.json`
 * (`BankVault4626.BankVaultStorage` as a member of a probe contract), compared field by field with the layout recorded
 * there for 0x129c…797D; also checks that no ordinary storage slot is used.
 */
function validateStorage(input) {
  const probe=JSON.parse(JSON.stringify(input)),name='IncidentStorageProbe.sol';
  probe.sources[name]={content:'pragma solidity ^0.8.27; import "'+SOURCE_PATH+'"; contract IncidentStorageProbe { BankVault4626.BankVaultStorage internal data; }'};
  probe.settings.outputSelection={'*':{'*':['storageLayout']}};
  const run=spawnSync(compiler(),['--standard-json'],{input:JSON.stringify(probe),encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(run.status,0,'solc failed');
  const out=JSON.parse(run.stdout),layout=out.contracts[name].IncidentStorageProbe.storageLayout;
  const now={storage:layout.types[layout.storage[0].type].members,types:layout.types};
  const deployed=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/incident-2026-11-04/storage-validation.json'),'utf8'))
    .contracts.find(row=>row.name==='BankVault4626').layouts.afterRemoval.custom;
  C.compareLayout(deployed,now);
  assert.equal(now.storage.length,deployed.storage.length,'Reconstructed vault must keep the 14 deployed fields');
  assert.equal(out.contracts[SOURCE_PATH].BankVault4626.storageLayout.storage.length,0,'Ordinary storage slot used');
  return {method:'probe struct BankVault4626.BankVaultStorage, compared with reports/incident-2026-11-04/storage-validation.json (afterRemoval)',
    fields:now.storage.map(m=>m.label),identicalToDeployed:true};
}
/** Runtime without its CBOR trailer (`{solc: 0.8.27}` here, bytecodeHash none): the executable code. */
function executable(code) {
  const hex=C.lower(code).replace(/^0x/,'');
  const trailer=parseInt(hex.slice(-4),16)*2+4;
  return '0x'+hex.slice(0,hex.length-trailer);
}
/** PUSH constants of ≥ 4 bytes present in one runtime but not the other (selectors, topics), for a near miss. */
function constantDiff(a,b) {
  const set=code=>new Set(C.disassemble(code).filter(o=>o.push>=4).map(o=>o.value));
  const sa=set(a),sb=set(b);
  return {onlyCompiled:[...sa].filter(v=>!sb.has(v)),onlyOnChain:[...sb].filter(v=>!sa.has(v))};
}
/** Replaces, in PUSH operands only, the compiled constant of each unresolved name with its on-chain value. */
function substituteUnresolved(code) {
  let hex=C.lower(code).replace(/^0x/,'');
  const rows=[];
  for(const row of UNRESOLVED_NAMES) {
    const full=id(row.signature).slice(2),compiled=row.kind==='error'?full.slice(0,8):full;
    const sites=C.disassemble('0x'+hex).filter(o=>o.push===compiled.length/2&&o.value===compiled);
    for(const {pc} of sites)hex=hex.slice(0,(pc+1)*2)+row.onChain+hex.slice((pc+1+compiled.length/2)*2);
    rows.push({...row,compiled,sites:sites.length});
  }
  return {code:'0x'+hex,rows};
}
class ReadOnlyProvider extends JsonRpcProvider {
  send(method,params) {
    assert(!/send|sign|personal_|hardhat|anvil|evm_|debug_/i.test(method),'Read-only provider refused '+method);
    return super.send(method,params);
  }
}

async function onChainRuntime(offline) {
  if(offline) {
    const archived=JSON.parse(fs.readFileSync(path.join(DIR,'match.json'),'utf8')).onChain;
    return {code:fs.readFileSync(RUNTIME_FILE,'utf8').trim(),block:archived.block,source:'archive'};
  }
  const provider=new ReadOnlyProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
  try {
    const block=await provider.getBlockNumber();
    return {code:await provider.getCode(IMPLEMENTATION,block),block,source:'eth_getCode'};
  } finally {provider.destroy();}
}

async function main() {
  const args=new Set(process.argv.slice(2));
  for(const arg of args)assert(['--offline','--write'].includes(arg),'Unknown argument '+arg);
  const input=buildInput();
  const compiled=compile(input);
  const runtime='0x'+compiled.evm.deployedBytecode.object;
  const chain=await onChainRuntime(args.has('--offline'));
  assert.notEqual(chain.code,'0x','No code at '+IMPLEMENTATION);
  const exactRuntime=C.lower(runtime)===C.lower(chain.code);
  const exactExecutable=executable(runtime)===executable(chain.code);
  const substituted=substituteUnresolved(runtime);
  const exactAfterSubstitution=C.lower(substituted.code)===C.lower(chain.code);
  const storage=validateStorage(input);
  const selectors=Object.values(compiled.evm.methodIdentifiers).map(s=>'0x'+s).sort();
  const report={
    implementation:IMPLEMENTATION,previousImplementation:PREVIOUS,
    upgradeTransaction:'0xb63c808cb835b0246b7478b8fc8c714bb69d57ed7d2c5a4af353c4e9cf82dbe0',
    source:'reports/vault-2026-11-05/BankVault4626.sol',sourceKeccak:id(input.sources[SOURCE_PATH].content),
    compilerInput:'reports/vault-2026-11-05/compiler-input.json',compilerInputKeccak:id(JSON.stringify(input)),
    compiler:'solc 0.8.27+commit.40a35a09 (native, --standard-json)',settings:input.settings,
    onChain:{block:chain.block,runtimeBytes:C.bytesOf(chain.code),runtimeKeccak:keccak256(chain.code),executableKeccak:keccak256(executable(chain.code))},
    compiled:{runtimeBytes:C.bytesOf(runtime),runtimeKeccak:keccak256(runtime),executableKeccak:keccak256(executable(runtime)),initcodeKeccak:keccak256('0x'+compiled.evm.bytecode.object)},
    exactRuntime,exactExecutable,
    unresolvedNames:{exactRuntimeAfterSubstitution:exactAfterSubstitution,substitutions:substituted.rows,
      note:'Only these constants differ: substituting them in the compiled runtime gives the on-chain runtime byte for byte (CBOR trailer included).'},
    storage,
    dispatcherMatchesAbi:JSON.stringify([...C.dispatcherSelectors(chain.code)].sort())===JSON.stringify(selectors),
    constantDiff:exactExecutable?undefined:constantDiff(runtime,chain.code),
  };
  if(args.has('--write')) {
    fs.writeFileSync(path.join(DIR,'compiler-input.json'),JSON.stringify(input,null,1)+'\n');
    fs.writeFileSync(path.join(DIR,'abi.json'),JSON.stringify(compiled.abi,null,1)+'\n');
    const previous=fs.existsSync(path.join(DIR,'match.json'))?JSON.parse(fs.readFileSync(path.join(DIR,'match.json'),'utf8')):{};
    fs.writeFileSync(path.join(DIR,'match.json'),C.stringify({...previous,...report,checkedAt:new Date().toISOString()}));
    if(chain.source==='eth_getCode')fs.writeFileSync(RUNTIME_FILE,chain.code+'\n');
  }
  console.log(C.stringify({...report,settings:undefined}));
  if(exactRuntime){console.log('EXACT MATCH (runtime incl. CBOR trailer) with '+IMPLEMENTATION+' at block '+chain.block);return;}
  if(exactAfterSubstitution){console.log('MATCH MODULO 2 UNRESOLVED NAMES (error selector 0x'+UNRESOLVED_NAMES[0].onChain+', event topic 0x'+UNRESOLVED_NAMES[1].onChain.slice(0,8)+'…): every other byte identical, CBOR trailer included, block '+chain.block);return;}
  console.error('MISMATCH: runtime differs from '+IMPLEMENTATION+' beyond the unresolved names');process.exitCode=1;
}

module.exports={buildInput,compile,executable,constantDiff,substituteUnresolved,UNRESOLVED_NAMES,IMPLEMENTATION};
if(require.main===module)main().catch(error=>{console.error(C.redact(error));process.exitCode=1;});
