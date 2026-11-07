// Mask bets v1 — shared, read-only helpers for the Arbitrum One upgrade and activation scripts.
// Nothing here signs or sends a transaction. No key, RPC secret or private URL is ever written to disk.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Contract,JsonRpcProvider,ZeroHash,getAddress,id,keccak256,zeroPadValue,toBeHex}=require('ethers');

const ROOT=path.resolve(__dirname,'..');
const MAINNET_CHAIN_ID=42161;
const LOCAL_CHAIN_ID=31337;
const MAINNET_CONFIRMATION='arbitrum-one:42161';
const CONFIRM_ENV='MASK_BETS_V1_MAINNET_CONFIRM';
const KEY_ENV='MASK_BETS_V1_ADMIN_KEY';
const RPC_ENV='ARBITRUM_RPC_URL';
const PUBLIC_RPC='https://arb1.arbitrum.io/rpc';
const RUNTIME_LIMIT=24576;
const INITCODE_LIMIT=49152;
const IMPLEMENTATION_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT='0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const PHASES=['Unset','Open','Locked','Settling','Completed'];
/** Upgrade window (spec §6.1): Open or Completed, never Settling; Locked (VRF in flight) is also refused. */
const UPGRADE_PHASES=new Set(['Open','Completed']);
/**
 * Recommended launch cap of mask legs per (round, market). At 448 legs the last chunk of a lane costs
 * ≈ 1.37–1.38M gas for one `UpkeepScheduler.checkUpkeep(lane)` eth_call (1 lane/60 payouts and 10 lanes/10
 * payouts, `test/VrfCallbackBudget.test.ts`), i.e. ≈ 1.40M with the intrinsic cost: under the ~1.5M target.
 * ≈ 2.7k gas per extra leg; 480 legs already reach 1.45–1.49M, 1 024 legs ≈ 2.93M.
 */
const LAUNCH_MASK_LEG_CAP=448;
const MAX_MASK_LEGS=65535;
const MAX_BPS=10000;

/** Linked libraries of the engine, in CREATE (topological) order. `key` is the manifest name. */
const LIBRARIES=[
  {name:'RouletteLib',key:'rouletteLib',source:'contracts/RouletteLib.sol'},
  {name:'RouletteBetLib',key:'rouletteBetLib',source:'contracts/libraries/RouletteBetLib.sol'},
  {name:'JackpotBatchLib',key:'jackpotBatchLib',source:'contracts/libraries/JackpotBatchLib.sol'},
  {name:'RoulettePayoutMulLib',key:'roulettePayoutMulLib',source:'contracts/libraries/RoulettePayoutMulLib.sol'},
  {name:'RouletteExposureLib',key:'rouletteExposureLib',source:'contracts/libraries/RouletteExposureLib.sol'},
  {name:'RouletteJackpotCollectLib',key:'rouletteJackpotCollectLib',source:'contracts/libraries/RouletteJackpotCollectLib.sol'},
  {name:'RoulettePayoutSweepLib',key:'roulettePayoutSweepLib',source:'contracts/libraries/RoulettePayoutSweepLib.sol'},
  {name:'RouletteLiabilityMathLib',key:'rouletteLiabilityMathLib',source:'contracts/libraries/RouletteLiabilityMathLib.sol'},
  {name:'RouletteBetCodecLib',key:'rouletteBetCodecLib',source:'contracts/libraries/RouletteBetCodecLib.sol'},
  {name:'RouletteUpkeepScanLib',key:'rouletteUpkeepScanLib',source:'contracts/libraries/RouletteUpkeepScanLib.sol'},
  {name:'RouletteMaskBetLib',key:'rouletteMaskBetLib',source:'contracts/libraries/RouletteMaskBetLib.sol'},
];
/** Expected on Arbitrum One: the new library, the two changed ones and the scan library that links the sweep. */
const MAINNET_EXPECTED_REDEPLOY=['RoulettePayoutSweepLib','RouletteLiabilityMathLib','RouletteUpkeepScanLib','RouletteMaskBetLib'];
const ENGINE={name:'RouletteEngine',source:'contracts/RouletteEngine.sol'};
const VAULT={name:'BankVault4626',source:'contracts/BankVault4626.sol'};
const RELEASE_LOCK=path.join(ROOT,'reports/mask-bets-v1/mainnet-release-lock.json');
/** Selectors the upgraded vault must no longer dispatch. */
const REMOVED_VAULT_FUNCTIONS=['lockSideBetStake(address,uint256,uint256)','setSideBetController(address)','sideBetController()'];

const ENGINE_ABI=[
  'function currentGlobalRound() view returns (uint64)',
  'function roundPhase(uint64) view returns (uint8)',
  'function hasPendingVrf() view returns (bool)',
  'function isBankLiquidityRestricted(uint32) view returns (bool)',
  'function marketRoundStateByRound(uint64,uint32) view returns (tuple(bool betsReleased,uint256 winningBetCount,uint256 bankPaidRunning,bool settled,tuple(uint256 totalAmount,uint256 betCount) totals))',
  'function hasRole(bytes32,address) view returns (bool)',
  'function ENGINE_ROUND_ROLE() view returns (bytes32)',
  'function REGISTRY() view returns (address)','function JACKPOT_TREASURY() view returns (address)','function JACKPOT_FUNDER() view returns (address)',
  'function VRF_SUBSCRIPTION_ID() view returns (uint256)','function VRF_CALLBACK_GAS_LIMIT() view returns (uint32)','function ROUND_DURATION() view returns (uint32)',
  'function UPKEEP_SCHEDULER() view returns (address)','function INFRA_RECIPIENT() view returns (address)',
  'function withdrawalQueueBatchSize() view returns (uint256)','function maxWithdrawalQueueLength() view returns (uint256)','function payoutParallelLaneCount() view returns (uint32)',
  'function VRF_KEY_HASH_2_GWEI() view returns (bytes32)','function VRF_KEY_HASH_30_GWEI() view returns (bytes32)','function VRF_KEY_HASH_150_GWEI() view returns (bytes32)',
  'function VRF_CONFIRMATIONS() view returns (uint16)','function BRB_REFERRAL() view returns (address)',
  'function maskBetState(uint64,uint32) view returns (uint32 maxLegsPerRound,uint16 maxLiabilityBps,uint256 legCount,uint256 weightedPayout)',
  'function setMaskBetLimits(uint32,uint32,uint16)',
  'function upgradeToAndCall(address,bytes) payable',
  'event MaskBetLimitsUpdated(uint32 marketId,uint32 maxLegsPerRound,uint16 maxLiabilityBps)',
];
const ENGINE_CONFIG_GETTERS=['REGISTRY','JACKPOT_TREASURY','JACKPOT_FUNDER','VRF_SUBSCRIPTION_ID','VRF_CALLBACK_GAS_LIMIT','ROUND_DURATION',
  'UPKEEP_SCHEDULER','INFRA_RECIPIENT','withdrawalQueueBatchSize','maxWithdrawalQueueLength','payoutParallelLaneCount',
  'VRF_KEY_HASH_2_GWEI','VRF_KEY_HASH_30_GWEI','VRF_KEY_HASH_150_GWEI','VRF_CONFIRMATIONS','BRB_REFERRAL'];
const VAULT_ABI=['function totalAssets() view returns (uint256)','function totalSupply() view returns (uint256)',
  'function lockedBetLiquidity() view returns (uint256)','function availableForSideBet() view returns (uint256)',
  'function hasRole(bytes32,address) view returns (bool)','function marketId() view returns (uint32)',
  'function lockSideBetStake(address,uint256,uint256)'];
const SIDE_BET_ABI=['function sideBetsDisabled() view returns (bool)','function reservedOf(uint32) view returns (uint256)',
  'function betCount() view returns (uint256)',
  'function getBet(uint256) view returns (tuple(address player,uint32 marketId,uint256 stake,uint256 payout,uint64 startGlobalRound,uint16 windowSpins,uint8 betType,uint8 color,uint8 targetNumber,uint16 targetCount,uint16 redRatioBps,uint8 status,uint64 placedAt,uint64 resolvedAt))'];
const BEACON_ABI=['function implementation() view returns (address)','function owner() view returns (address)','function upgradeTo(address)'];
const REGISTRY_ABI=['function marketCount() view returns (uint32)','function getMarket(uint32) view returns (tuple(address asset,address bank))'];

const stringify=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const lower=address=>String(address).toLowerCase();
const addressEqual=(actual,expected,message)=>assert.equal(lower(actual),lower(expected),message);
const redact=error=>String(error?.shortMessage||error?.message||error).replace(/https?:\/\/\S+/g,'[RPC]').slice(0,1600);
const bytesOf=hex=>(hex.length-2)/2;

// ── Artifacts ────────────────────────────────────────────────────────────────────
function readArtifact(source,name,root=ROOT) {
  const file=path.join(root,'artifacts',source,name+'.json');
  assert(fs.existsSync(file),'Missing artifact '+name+': run yarn compile');
  const artifact=JSON.parse(fs.readFileSync(file,'utf8'));
  const dbg=JSON.parse(fs.readFileSync(file.replace(/\.json$/,'.dbg.json'),'utf8'));
  return {...artifact,buildInfoPath:path.resolve(path.dirname(file),dbg.buildInfo)};
}
const buildInfos=new Map();
function compilerOutput(artifact) {
  if(!buildInfos.has(artifact.buildInfoPath))buildInfos.set(artifact.buildInfoPath,JSON.parse(fs.readFileSync(artifact.buildInfoPath,'utf8')));
  return buildInfos.get(artifact.buildInfoPath);
}
function immutableRanges(artifact) {
  const out=compilerOutput(artifact).output.contracts[artifact.sourceName][artifact.contractName];
  return Object.values(out.evm.deployedBytecode.immutableReferences||{}).flat();
}
function loadArtifacts(root=ROOT) {
  const libraries=Object.fromEntries(LIBRARIES.map(lib=>[lib.name,readArtifact(lib.source,lib.name,root)]));
  return {libraries,engine:readArtifact(ENGINE.source,ENGINE.name,root),vault:readArtifact(VAULT.source,VAULT.name,root)};
}

/** Replaces every `__$…$__` placeholder from `linkReferences` with the library address. */
function link(bytecode,linkReferences,addressByName) {
  let hex=bytecode.slice(2);
  for(const libraries of Object.values(linkReferences||{}))for(const [name,refs] of Object.entries(libraries)) {
    const address=addressByName[name];
    assert(address,'No address to link '+name);
    const body=lower(getAddress(address)).slice(2);
    for(const {start,length} of refs) {assert.equal(length,20);hex=hex.slice(0,start*2)+body+hex.slice((start+length)*2);}
  }
  assert(!hex.includes('__$'),'Unlinked library placeholder left');
  return '0x'+hex;
}
const linkCreation=(artifact,addresses)=>link(artifact.bytecode,artifact.linkReferences,addresses);
const linkRuntime=(artifact,addresses)=>link(artifact.deployedBytecode,artifact.deployedLinkReferences,addresses);

/**
 * Executable runtime only: drops the CBOR metadata trailer, the library self-address (PUSH20 at offset 1)
 * and every immutable range, so two builds that differ only by source metadata compare equal.
 */
function normalizeRuntime(code,{library=false,immutables=[]}={}) {
  let hex=lower(code).replace(/^0x/,'');
  assert(hex.length>=4,'Empty runtime code');
  const metadataBytes=parseInt(hex.slice(-4),16);
  if(metadataBytes>0&&metadataBytes*2+4<hex.length)hex=hex.slice(0,hex.length-(metadataBytes*2+4));
  const zero=(start,length)=>{if(start*2<hex.length)hex=hex.slice(0,start*2)+'00'.repeat(length)+hex.slice((start+length)*2);};
  if(library&&hex.startsWith('73'))zero(1,20);
  for(const {start,length} of immutables)zero(start,length);
  return hex;
}
/** 32-byte words stored at the immutable ranges of a deployed runtime. */
function immutableValues(code,ranges) {
  const hex=lower(code).replace(/^0x/,'');
  return [...new Set(ranges.map(({start,length})=>'0x'+hex.slice(start*2,(start+length)*2)))].sort();
}
/** Opcodes of a runtime, PUSH data skipped (so a selector inside push data or metadata is never an opcode). */
function disassemble(code) {
  const bytes=Buffer.from(lower(code).replace(/^0x/,''),'hex'),out=[];
  for(let pc=0;pc<bytes.length;) {
    const op=bytes[pc];
    if(op>=0x5f&&op<=0x7f) {
      const size=op-0x5f;
      out.push({pc,op,push:size,value:bytes.subarray(pc+1,pc+1+size).toString('hex')});
      pc+=1+size;
    } else {out.push({pc,op,push:-1,value:null});pc+=1;}
  }
  return out;
}
const OP={JUMPDEST:0x5b,DUP1:0x80,EQ:0x14,GT:0x11,LT:0x10,JUMPI:0x57,JUMP:0x56,SHR:0x1c,CALLDATALOAD:0x35};
/**
 * Function selectors of a solc dispatcher, read from a proper disassembly. solc compares each selector with the
 * SMALLEST push that holds it: `0x00e4a032` (`drainWithdrawalQueue(uint256)`) is `PUSH3 e4a032`, never
 * `PUSH4 00e4a032`, so searching the hex for `63`+selector misses it (the 2026-11-06 false positive). Reads
 * `DUP1 PUSHn s EQ PUSH2 t JUMPI` entries (and skips `GT`/`LT` bucket pivots) from the selector load
 * (`CALLDATALOAD PUSH1 e0 SHR`) to the end of the table. A `0x00000000` selector (`DUP1 ISZERO`) is not handled.
 */
function dispatcherSelectors(code) {
  const ops=disassemble(code);
  let i=ops.findIndex((o,k)=>o.op===OP.CALLDATALOAD&&ops[k+1]?.push===1&&ops[k+1].value==='e0'&&ops[k+2]?.op===OP.SHR);
  assert(i>=0,'No solc selector dispatcher in this runtime');
  const selectors=new Set();
  const entry=k=>ops[k]?.op===OP.DUP1&&ops[k+1]?.push>=1&&ops[k+1].push<=4&&[OP.EQ,OP.GT,OP.LT].includes(ops[k+2]?.op)
    &&ops[k+3]?.push>=1&&ops[k+4]?.op===OP.JUMPI;
  for(i+=3;i<ops.length;) {
    if(ops[i].op===OP.JUMPDEST){i++;continue;}
    if(entry(i)){if(ops[i+2].op===OP.EQ)selectors.add('0x'+ops[i+1].value.padStart(8,'0'));i+=5;continue;}
    // Jump to the shared fallback between buckets.
    if(ops[i].push>=1&&ops[i+1]?.op===OP.JUMP&&ops[i+2]?.op===OP.JUMPDEST&&entry(i+3)){i+=2;continue;}
    break;
  }
  return selectors;
}
/** True when the runtime dispatches `signature` (PUSH4 selector), the usual check for a removed function. */
function dispatchesSelector(code,signature) {
  return lower(code).includes('63'+keccak256(Buffer.from(signature)).slice(2,10));
}

/** Hashes and sizes of every artifact this release deploys (reviewed once, committed as the release lock). */
function releaseLock(artifacts) {
  const rows={};
  for(const [name,artifact] of [...Object.entries(artifacts.libraries),[ENGINE.name,artifacts.engine],[VAULT.name,artifacts.vault]]) {
    // Hash of the hex text: unlinked placeholders (__$…$__) are not valid bytes.
    rows[name]={bytecodeHash:id(artifact.bytecode),deployedBytecodeHash:id(artifact.deployedBytecode),
      runtimeBytes:bytesOf(artifact.deployedBytecode),initcodeBytes:bytesOf(artifact.bytecode)};
  }
  return {compiler:compilerOutput(artifacts.engine).solcLongVersion,artifacts:rows};
}
function assertSizes(artifacts) {
  const rows=[];
  for(const [name,artifact] of [...Object.entries(artifacts.libraries),[ENGINE.name,artifacts.engine],[VAULT.name,artifacts.vault]]) {
    const row={name,runtimeBytes:bytesOf(artifact.deployedBytecode),initcodeBytes:bytesOf(artifact.bytecode)};
    assert(row.runtimeBytes<=RUNTIME_LIMIT,name+' runtime exceeds EIP-170 ('+row.runtimeBytes+')');
    assert(row.initcodeBytes<=INITCODE_LIMIT,name+' initcode exceeds EIP-3860 ('+row.initcodeBytes+')');
    rows.push(row);
  }
  return rows;
}

// ── Storage layouts (same recursive comparison as scripts/incident20261104.cjs) ───────
function compareLayout(before,after,renamed={}) {
  const seen=new Set();
  function members(a,b,label) {
    assert(b.length>=a.length,label+' removed fields');
    for(let i=0;i<a.length;i++) {
      assert.equal(b[i].label,renamed[a[i].label]??a[i].label,label+' label #'+i);
      for(const k of ['slot','offset'])assert.equal(b[i][k],a[i][k],label+'.'+a[i].label+' '+k);
      types(a[i].type,b[i].type,label+'.'+a[i].label);
    }
  }
  function types(aid,bid,label,fixed=false) {
    const key=aid+'|'+bid+'|'+fixed;if(seen.has(key))return;seen.add(key);
    const a=before.types[aid],b=after.types[bid];
    assert(a&&b,label+' missing type');assert.equal(b.encoding,a.encoding,label+' encoding');
    if(fixed||!a.members)assert.equal(b.numberOfBytes,a.numberOfBytes,label+' width/stride');
    if(a.members)members(a.members,b.members,label);
    else if(a.encoding==='mapping'){types(a.key,b.key,label+' key');types(a.value,b.value,label+' value');}
    else if(a.base)types(a.base,b.base,label+' item',true);
    else assert.equal(b.label.replace(/\s+/g,' '),a.label.replace(/\s+/g,' '),label+' type');
  }
  members(before.storage,after.storage,'storage');
}
function probeLayout(root,probe) {
  const artifact=readArtifact('contracts/test/StorageLayoutProbes.sol',probe,root);
  const layout=compilerOutput(artifact).output.contracts[artifact.sourceName][probe].storageLayout;
  return {storage:layout.types[layout.storage[0].type].members,types:layout.types};
}
/**
 * Engine: master layout (deployed engine) is a strict prefix of the new one, the five mask fields appended.
 * Vault: the deployed 14-field layout (incident report) is unchanged, one field renamed. Both contracts keep
 * no ordinary (non-namespaced) storage.
 */
function validateStorage(artifacts,root=ROOT) {
  const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  const engineBefore=read('reports/mask-bets-v1/storage-baseline-master.json').engine;
  const engineNow=probeLayout(root,'EngineStorageLayoutProbe');
  compareLayout(engineBefore,engineNow);
  const appended=engineNow.storage.slice(engineBefore.storage.length).map(member=>member.label);
  assert.deepEqual(appended,['roundMaskBets','roundMaskWinCounts','roundMaskWeightedPayout','maxMaskLegsPerMarketRound','maxMaskLiabilityBps'],'Unexpected appended engine fields');
  const vaultDeployed=read('reports/incident-2026-11-04/storage-validation.json').contracts
    .find(row=>row.name==='BankVault4626').layouts.afterRemoval.custom;
  const vaultNow=probeLayout(root,'VaultStorageLayoutProbe');
  compareLayout(vaultDeployed,vaultNow,{sideBetController:'_deprecatedSideBetController'});
  assert.equal(vaultNow.storage.length,vaultDeployed.storage.length,'Vault layout must keep exactly '+vaultDeployed.storage.length+' fields');
  for(const [name,artifact] of [[ENGINE.name,artifacts.engine],[VAULT.name,artifacts.vault]]) {
    const ordinary=compilerOutput(artifact).output.contracts[artifact.sourceName][artifact.contractName].storageLayout.storage;
    assert.equal(ordinary.length,0,name+' must not use ordinary storage slots');
  }
  return {engineFieldsBefore:engineBefore.storage.length,engineFieldsAfter:engineNow.storage.length,appended,
    vaultFieldsDeployed:vaultDeployed.storage.length,vaultFieldsAfter:vaultNow.storage.length,renamed:{sideBetController:'_deprecatedSideBetController'}};
}

// ── Deployment manifest ──────────────────────────────────────────────────────────
/** Arbitrum One addresses, current implementations and the live engine's constructor arguments. */
function loadMainnetDeployment(root=ROOT) {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'deployments/arbitrum-one.json'),'utf8'));
  const a=manifest.addresses;
  const engineImplementation=a.engineImplementation;
  const history=(manifest.upgradeHistory||[]).filter(row=>row.newImplementation&&lower(row.newImplementation)===lower(engineImplementation));
  assert.equal(history.length,1,'Live engine implementation must have exactly one upgradeHistory entry');
  const clean=JSON.parse(fs.readFileSync(path.join(root,'reports/incident-2026-11-04/future-upgrade-artifacts.json'),'utf8'));
  return {
    label:'arbitrum-one',chainId:MAINNET_CHAIN_ID,admin:getAddress(manifest.protocolAdmin),
    engine:getAddress(a.engine),engineImplementation:getAddress(engineImplementation),
    beacon:getAddress(a.vaultBeacon),bankVaultImplementation:getAddress(a.bankVaultImplementation),
    // Runtime of the bank implementation installed by the 2026-11-04 cleanup (incident report artifact).
    bankVaultRuntimeHash:keccak256(clean.BankVault4626.deployedBytecode),
    banks:a.banks.map(bank=>getAddress(bank)),registry:getAddress(a.registry),sideBet:getAddress(a.sideBet),
    linkedLibraries:Object.fromEntries(Object.entries(manifest.linkedLibraries).map(([k,v])=>[k,getAddress(v)])),
    engineConstructorArgs:history[0].constructorArguments,
    expectedRedeploy:MAINNET_EXPECTED_REDEPLOY,
  };
}

// ── Network guards ───────────────────────────────────────────────────────────────
/**
 * `mainnet`: real chain 42161, not a Hardhat node; `execute` additionally needs the typed confirmation.
 * `local`: Hardhat network 31337 that is NOT a fork (unit tests only). Anything else fails closed.
 */
async function assertNetwork(provider,network,{execute=false}={}) {
  assert(['mainnet','local'].includes(network),'Select the network explicitly');
  const chainId=Number(BigInt(await provider.send('eth_chainId',[])));
  let metadata;
  try {metadata=await provider.send('hardhat_metadata',[]);} catch {metadata=undefined;}
  if(network==='mainnet') {
    assert.equal(chainId,MAINNET_CHAIN_ID,'Unexpected chain '+chainId+'; nothing sent');
    assert(!metadata,'Mainnet mode cannot use a Hardhat node or fork');
    if(execute)assert.equal(process.env[CONFIRM_ENV],MAINNET_CONFIRMATION,'Execution requires '+CONFIRM_ENV+'='+MAINNET_CONFIRMATION);
  } else {
    assert.equal(chainId,LOCAL_CHAIN_ID,'Local mode requires chain 31337');
    assert(metadata&&metadata.chainId===LOCAL_CHAIN_ID,'Local mode requires a Hardhat network');
    assert(!metadata.forkedNetwork,'Local mode refuses forks: no fork is part of this release');
  }
  return chainId;
}
/** JSON-RPC provider that refuses every method able to sign, send or alter state. */
class ReadOnlyProvider extends JsonRpcProvider {
  send(method,params) {
    assert(!/send|sign|personal_|hardhat_set|hardhat_impersonate|anvil|evm_|debug_/i.test(method),'Read-only provider refused '+method);
    return super.send(method,params);
  }
}
function rpcUrl() {return process.env[RPC_ENV]||PUBLIC_RPC;}
/** Operator key from the environment only (never a file or Hardhat var), checked against the admin. */
function operatorSigner(provider,admin) {
  const key=process.env[KEY_ENV];
  assert(key&&/^(0x)?[0-9a-fA-F]{64}$/.test(key.trim()),'Execution requires the admin key in '+KEY_ENV+' (operator-supplied, never stored)');
  const {Wallet}=require('ethers');
  const wallet=new Wallet(key.trim(),provider);
  addressEqual(wallet.address,admin,'Signer is not the protocol admin');
  return wallet;
}

// ── Reads ────────────────────────────────────────────────────────────────────────
const contracts=(provider,d)=>({
  engine:new Contract(d.engine,ENGINE_ABI,provider),beacon:new Contract(d.beacon,BEACON_ABI,provider),
  registry:new Contract(d.registry,REGISTRY_ABI,provider),sideBet:new Contract(d.sideBet,SIDE_BET_ABI,provider),
  bank:address=>new Contract(address,VAULT_ABI,provider),
});
async function implementationOf(provider,proxy,blockTag='latest') {
  return getAddress('0x'+(await provider.getStorage(proxy,IMPLEMENTATION_SLOT,blockTag)).slice(-40));
}
async function beaconOf(provider,proxy) {return getAddress('0x'+(await provider.getStorage(proxy,BEACON_SLOT)).slice(-40));}

/** Global phase + per-market restriction. Throws outside the upgrade window. */
async function assertUpgradeWindow(c,marketIds) {
  const round=await c.engine.currentGlobalRound();
  const phase=PHASES[Number(await c.engine.roundPhase(round))]??'Unknown';
  assert(UPGRADE_PHASES.has(phase),'Round '+round+' is '+phase+': upgrade only in Open or Completed, never Settling');
  assert.equal(await c.engine.hasPendingVrf(),false,'A VRF request is pending; wait for settlement');
  for(const marketId of marketIds)assert.equal(await c.engine.isBankLiquidityRestricted(marketId),false,'Market '+marketId+' is settling');
  return {round,phase};
}
/** Side bets must be disabled with no open ticket and no reserve; each bank lock must equal its unreleased roulette stakes. */
async function assertSideBetsInert(c,markets,round) {
  assert.equal(await c.sideBet.sideBetsDisabled(),true,'SideBet must be disabled (sideBetsDisabled() == true)');
  const tickets=Number(await c.sideBet.betCount());
  assert(tickets<=5000,'Unexpected SideBet ticket count '+tickets);
  const active=[];
  for(let id=0;id<tickets;id++)if(Number((await c.sideBet.getBet(id)).status)===0)active.push(id);
  assert.deepEqual(active,[],'Open SideBet tickets: '+active.join(','));
  const banks=[];
  for(const {marketId,bank} of markets) {
    const reserved=await c.sideBet.reservedOf(marketId);
    assert.equal(reserved,0n,'Market '+marketId+' has a side-bet reserve of '+reserved);
    const mr=await c.engine.marketRoundStateByRound(round,marketId);
    const expectedLock=mr.betsReleased?0n:mr.totals.totalAmount;
    const locked=await c.bank(bank).lockedBetLiquidity();
    assert.equal(locked,expectedLock,'Bank '+bank+' lock '+locked+' != unreleased roulette stakes '+expectedLock);
    banks.push({marketId,bank,locked,roundStakes:mr.totals.totalAmount,betsReleased:mr.betsReleased});
  }
  return {ticketCount:tickets,activeTickets:0,banks};
}
async function marketsOf(c,d) {
  const count=Number(await c.registry.marketCount());
  assert.equal(count,d.banks.length,'Registry has '+count+' markets, manifest lists '+d.banks.length);
  const markets=[];
  for(let marketId=1;marketId<=count;marketId++) {
    const {bank}=await c.registry.getMarket(marketId);
    addressEqual(bank,d.banks[marketId-1],'Market '+marketId+' bank differs from the manifest');
    markets.push({marketId,bank:getAddress(bank)});
  }
  return markets;
}
async function bankBalances(c,markets,blockTag='latest') {
  const rows=[];
  for(const {marketId,bank} of markets) {
    const v=c.bank(bank);
    rows.push({marketId,bank,totalAssets:await v.totalAssets({blockTag}),totalSupply:await v.totalSupply({blockTag})});
  }
  return rows;
}
async function engineConfig(c) {
  const out={};
  for(const getter of ENGINE_CONFIG_GETTERS)out[getter]=await c.engine[getter]();
  return out;
}

module.exports={ROOT,MAINNET_CHAIN_ID,LOCAL_CHAIN_ID,MAINNET_CONFIRMATION,CONFIRM_ENV,KEY_ENV,RPC_ENV,PUBLIC_RPC,
  RUNTIME_LIMIT,INITCODE_LIMIT,IMPLEMENTATION_SLOT,PHASES,LAUNCH_MASK_LEG_CAP,MAX_MASK_LEGS,MAX_BPS,LIBRARIES,
  MAINNET_EXPECTED_REDEPLOY,ENGINE,VAULT,RELEASE_LOCK,REMOVED_VAULT_FUNCTIONS,ENGINE_ABI,VAULT_ABI,BEACON_ABI,
  stringify,lower,addressEqual,redact,bytesOf,readArtifact,loadArtifacts,immutableRanges,link,linkCreation,linkRuntime,
  normalizeRuntime,immutableValues,disassemble,dispatcherSelectors,dispatchesSelector,releaseLock,assertSizes,compareLayout,validateStorage,
  loadMainnetDeployment,assertNetwork,ReadOnlyProvider,rpcUrl,operatorSigner,contracts,implementationOf,beaconOf,
  assertUpgradeWindow,assertSideBetsInert,marketsOf,bankBalances,engineConfig,ZeroHash,zeroPadValue,toBeHex};
