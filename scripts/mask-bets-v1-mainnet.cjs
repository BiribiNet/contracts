#!/usr/bin/env node
// Mask bets v1 — direct Arbitrum One upgrade (owner decision 2026-11-06: no Sepolia, no fork).
//
// Deploys the libraries that changed (or link one that changed), the new RouletteEngine and BankVault4626
// implementations, then upgrades the engine proxy (UUPS) BEFORE the vault beacon: the new engine reads
// `totalAssets()`, which the current vault already serves, whereas the old engine needs `availableForSideBet()`.
// Mask bets ship DISABLED (maxMaskLegsPerMarketRound = 0 everywhere); activation is the separate
// `scripts/mask-bets-v1-activate.cjs`.
//
//   node scripts/mask-bets-v1-mainnet.cjs                      # dry run (default): read-only preflight + plan
//   node scripts/mask-bets-v1-mainnet.cjs --out plan.json      # same, full calldata saved for a multisig
//   node scripts/mask-bets-v1-mainnet.cjs --write-lock         # record reviewed artifact hashes (no RPC)
//   MASK_BETS_V1_MAINNET_CONFIRM=arbitrum-one:42161 MASK_BETS_V1_ADMIN_KEY=… \
//     node scripts/mask-bets-v1-mainnet.cjs --execute          # real transactions
//
// RPC: ARBITRUM_RPC_URL, else the public https://arb1.arbitrum.io/rpc (dry run needs no secret).
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Interface,getCreateAddress,getAddress,keccak256,toBeHex,zeroPadValue}=require('ethers');
const C=require('./mask-bets-v1-common.cjs');

const UPGRADE_DIR=path.join(C.ROOT,'reports/mask-bets-v1');

/**
 * Decides which libraries to redeploy: a library is reused only when its executable runtime on chain
 * (metadata and self-address excluded) equals the compiled one linked to the addresses already in use.
 * A library linking a redeployed one is redeployed too. Fails if the result differs from `expectedRedeploy`.
 */
async function resolveLibraries(provider,d,artifacts) {
  const redeploy=new Set(),rows=[],address={};
  for(const lib of C.LIBRARIES) {
    const artifact=artifacts.libraries[lib.name];
    const deps=Object.values(artifact.deployedLinkReferences||{}).flatMap(group=>Object.keys(group));
    const existing=d.linkedLibraries[lib.key];
    let reason;
    if(!existing)reason='new library';
    else if(deps.some(dep=>redeploy.has(dep)))reason='links redeployed '+deps.filter(dep=>redeploy.has(dep)).join(', ');
    else {
      const onchain=await provider.getCode(existing);
      assert.notEqual(onchain,'0x','Linked library '+lib.name+' has no code at '+existing);
      const same=C.normalizeRuntime(onchain,{library:true})===C.normalizeRuntime(C.linkRuntime(artifact,address),{library:true});
      if(!same)reason='executable runtime differs from the deployed library';
    }
    if(reason)redeploy.add(lib.name);else address[lib.name]=getAddress(existing);
    rows.push({name:lib.name,action:reason?'deploy':'reuse',reason:reason||'identical executable runtime',current:existing||null});
  }
  assert.deepEqual([...redeploy].sort(),[...d.expectedRedeploy].sort(),'Library redeploy set differs from the reviewed plan');
  return {rows,reused:address,redeploy:C.LIBRARIES.filter(lib=>redeploy.has(lib.name)).map(lib=>lib.name)};
}

/** Ordered transactions with CREATE addresses predicted from `from` and its pending nonce. */
function buildTransactions({d,artifacts,libraries,from,nonce}) {
  const addresses={...libraries.reused},steps=[];
  const push=step=>{steps.push({index:steps.length,nonce:nonce+steps.length,...step,dataHash:keccak256(step.data),dataBytes:C.bytesOf(step.data)});};
  for(const name of libraries.redeploy) {
    const predicted=getCreateAddress({from,nonce:nonce+steps.length});
    const artifact=artifacts.libraries[name];
    push({label:'Deploy '+name,kind:'deploy',name,to:null,data:C.linkCreation(artifact,addresses),predicted,
      expectedRuntime:C.linkRuntime(artifact,addresses),library:true});
    addresses[name]=predicted;
  }
  const engineAddress=getCreateAddress({from,nonce:nonce+steps.length});
  const engineInterface=new Interface(artifacts.engine.abi);
  push({label:'Deploy RouletteEngine implementation',kind:'deploy',name:'RouletteEngine',to:null,
    data:C.linkCreation(artifacts.engine,addresses)+engineInterface.encodeDeploy(d.engineConstructorArgs).slice(2),
    predicted:engineAddress,expectedRuntime:C.linkRuntime(artifacts.engine,addresses),library:false});
  const vaultAddress=getCreateAddress({from,nonce:nonce+steps.length});
  push({label:'Deploy BankVault4626 implementation',kind:'deploy',name:'BankVault4626',to:null,data:artifacts.vault.bytecode,
    predicted:vaultAddress,expectedRuntime:artifacts.vault.deployedBytecode,library:false});
  push({label:'Upgrade RouletteEngine proxy (UUPS, masks disabled)',kind:'call',name:'upgradeToAndCall',to:d.engine,
    data:new Interface(C.ENGINE_ABI).encodeFunctionData('upgradeToAndCall',[engineAddress,'0x'])});
  push({label:'Upgrade BankVault4626 beacon',kind:'call',name:'upgradeTo',to:d.beacon,
    data:new Interface(C.BEACON_ABI).encodeFunctionData('upgradeTo',[vaultAddress])});
  return {steps,addresses:{...addresses,RouletteEngine:engineAddress,BankVault4626:vaultAddress}};
}

/** Read-only checks that must all pass before the first transaction. Returns the evidence it read. */
async function preflight({provider,d,artifacts,from,lockPath=C.RELEASE_LOCK,root=C.ROOT}) {
  const report={};
  if(lockPath) {
    assert(fs.existsSync(lockPath),'Missing release lock '+path.relative(root,lockPath)+': review the build, then run --write-lock');
    assert.deepEqual(C.releaseLock(artifacts),JSON.parse(fs.readFileSync(lockPath,'utf8')),
      'Compiled artifacts differ from the reviewed release lock; nothing sent');
    report.releaseLock='matches '+path.relative(root,lockPath);
  }
  report.sizes=C.assertSizes(artifacts);
  report.storage=C.validateStorage(artifacts,root);
  const c=C.contracts(provider,d);
  // Owner and roles.
  const roundRole=await c.engine.ENGINE_ROUND_ROLE();
  assert.equal(await c.engine.hasRole(C.ZeroHash,d.admin),true,'Admin lacks DEFAULT_ADMIN_ROLE on the engine');
  assert.equal(await c.engine.hasRole(roundRole,d.admin),true,'Admin lacks ENGINE_ROUND_ROLE (needed for activation)');
  C.addressEqual(await c.beacon.owner(),d.admin,'Vault beacon owner is not the admin');
  C.addressEqual(from,d.admin,'Transactions must come from the admin');
  // Current implementations and bytecode.
  const engineImplementation=await C.implementationOf(provider,d.engine);
  C.addressEqual(engineImplementation,d.engineImplementation,'Engine implementation differs from the manifest');
  const vaultImplementation=await c.beacon.implementation();
  C.addressEqual(vaultImplementation,d.bankVaultImplementation,'Beacon implementation differs from the manifest');
  if(d.bankVaultRuntimeHash)assert.equal(keccak256(await provider.getCode(vaultImplementation)),d.bankVaultRuntimeHash,'Deployed bank bytecode is not the expected one');
  const [coordinator,key2,key30,key150,confirmations,referral]=d.engineConstructorArgs;
  assert.equal(await c.engine.VRF_KEY_HASH_2_GWEI(),key2);assert.equal(await c.engine.VRF_KEY_HASH_30_GWEI(),key30);
  assert.equal(await c.engine.VRF_KEY_HASH_150_GWEI(),key150);assert.equal(Number(await c.engine.VRF_CONFIRMATIONS()),Number(confirmations));
  C.addressEqual(await c.engine.BRB_REFERRAL(),referral,'BRB_REFERRAL differs from the recorded constructor argument');
  assert(C.lower(await provider.getCode(engineImplementation)).includes(C.lower(zeroPadValue(coordinator,32)).slice(2)),
    'Live engine implementation does not embed the recorded VRF coordinator');
  const markets=await C.marketsOf(c,d);
  for(const {bank} of markets)C.addressEqual(await C.beaconOf(provider,bank),d.beacon,'Bank '+bank+' is not behind the vault beacon');
  // Upgrade window and side-bet state.
  const window=await C.assertUpgradeWindow(c,markets.map(m=>m.marketId));
  const sideBets=await C.assertSideBetsInert(c,markets,window.round);
  const latest=await provider.getTransactionCount(from,'latest'),pending=await provider.getTransactionCount(from,'pending');
  assert.equal(pending,latest,'The admin has pending transactions');
  const libraries=await resolveLibraries(provider,d,artifacts);
  Object.assign(report,{block:await provider.getBlockNumber(),engineImplementation,vaultImplementation,markets,window,sideBets,
    bankAdminRoles:await Promise.all(markets.map(async m=>({bank:m.bank,adminHasDefaultRole:await c.bank(m.bank).hasRole(C.ZeroHash,d.admin)}))),
    balances:await C.bankBalances(c,markets),engineConfig:await C.engineConfig(c),libraries,nonce:latest});
  return report;
}

/** On-chain runtime equals the compiled one (linked), immutables equal to the constructor values. */
async function verifyDeployment(provider,step,artifacts,d) {
  const code=await provider.getCode(step.predicted);
  assert.notEqual(code,'0x',step.name+' has no code at '+step.predicted);
  const artifact=step.library?artifacts.libraries[step.name]:step.name==='RouletteEngine'?artifacts.engine:artifacts.vault;
  const ranges=step.library?[]:C.immutableRanges(artifact);
  assert.equal(C.normalizeRuntime(code,{library:step.library,immutables:ranges}),
    C.normalizeRuntime(step.expectedRuntime,{library:step.library,immutables:ranges}),step.name+' runtime differs from the artifact');
  assert.equal(C.bytesOf(code),C.bytesOf(step.expectedRuntime),step.name+' runtime size differs');
  if(step.name==='RouletteEngine') {
    const [coordinator,key2,key30,key150,confirmations,referral]=d.engineConstructorArgs;
    const expected=[zeroPadValue(coordinator,32),key2,key30,key150,zeroPadValue(toBeHex(BigInt(confirmations)),32),
      zeroPadValue(referral,32),zeroPadValue(step.predicted,32)].map(C.lower);
    assert.deepEqual(C.immutableValues(code,ranges),[...new Set(expected)].sort(),'Engine immutables differ from the constructor arguments');
  }
  return {address:step.predicted,runtimeHash:keccak256(code),runtimeBytes:C.bytesOf(code)};
}

/** Engine proxy on the new implementation, configuration and roles unchanged, masks disabled on every market. */
async function verifyEngineUpgrade({provider,d,newImplementation,markets,configBefore}) {
  const c=C.contracts(provider,d);
  C.addressEqual(await C.implementationOf(provider,d.engine),newImplementation,'Engine proxy is not on the new implementation');
  assert.deepEqual(await C.engineConfig(c),configBefore,'Engine configuration changed during the upgrade');
  assert.equal(await c.engine.hasRole(C.ZeroHash,d.admin),true);
  assert.equal(await c.engine.hasRole(await c.engine.ENGINE_ROUND_ROLE(),d.admin),true);
  const round=await c.engine.currentGlobalRound(),maskState=[];
  for(const {marketId} of markets) {
    const [maxLegs,maxBps,legs,weighted]=await c.engine.maskBetState(round,marketId);
    assert.deepEqual([maxLegs,maxBps,legs,weighted].map(BigInt),[0n,0n,0n,0n],'Market '+marketId+': masks must ship disabled and empty');
    maskState.push({marketId,maxLegsPerRound:0,maxLiabilityBps:0,legCount:0,weightedPayout:'0'});
  }
  return {round,maskState};
}

/**
 * Beacon on the new implementation; its runtime no longer dispatches the side-bet entry points; for each bank
 * totalAssets()/totalSupply() are identical right before and after the upgrade block and availableForSideBet()
 * equals totalAssets().
 */
async function verifyVaultUpgrade({provider,d,newImplementation,markets,upgradeBlock}) {
  const c=C.contracts(provider,d);
  C.addressEqual(await c.beacon.implementation(),newImplementation,'Beacon is not on the new implementation');
  const code=await provider.getCode(newImplementation);
  for(const signature of C.REMOVED_VAULT_FUNCTIONS)assert.equal(C.dispatchesSelector(code,signature),false,'Vault still dispatches '+signature);
  const before=await C.bankBalances(c,markets,upgradeBlock-1),after=await C.bankBalances(c,markets,upgradeBlock);
  assert.deepEqual(after,before,'totalAssets()/totalSupply() changed across the beacon upgrade');
  const banks=[];
  for(const {marketId,bank} of markets) {
    const v=c.bank(bank);
    const assets=await v.totalAssets();
    assert.equal(await v.availableForSideBet(),assets,'availableForSideBet() != totalAssets() on '+bank);
    await assert.rejects(v.lockSideBetStake.staticCall(d.admin,1n,1n),'lockSideBetStake still callable on '+bank);
    banks.push({marketId,bank,totalAssets:assets,availableForSideBet:assets});
  }
  return {balancesAroundUpgrade:after,banks,removedFunctions:C.REMOVED_VAULT_FUNCTIONS};
}

/** Dry run: preflight + plan + gas estimates for the deployments. Never signs. */
async function planUpgrade({provider,d,network,from=d.admin,lockPath,root}) {
  const chainId=await C.assertNetwork(provider,network);
  const artifacts=C.loadArtifacts(root);
  const checks=await preflight({provider,d,artifacts,from,lockPath,root});
  const {steps,addresses}=buildTransactions({d,artifacts,libraries:checks.libraries,from,nonce:checks.nonce});
  for(const step of steps.filter(s=>s.kind==='deploy'))step.gasEstimate=await provider.estimateGas({from,data:step.data});
  return {chainId,checks,steps,addresses};
}

async function executeUpgrade({provider,signer,d,network,reportPath,lockPath,root}) {
  const chainId=await C.assertNetwork(provider,network,{execute:true});
  const from=await signer.getAddress();
  C.addressEqual(from,d.admin,'Signer is not the protocol admin');
  assert.equal(signer.provider,provider,'Signer must use the checked provider');
  const artifacts=C.loadArtifacts(root);
  const checks=await preflight({provider,d,artifacts,from,lockPath,root});
  const {steps,addresses}=buildTransactions({d,artifacts,libraries:checks.libraries,from,nonce:checks.nonce});
  const c=C.contracts(provider,d);
  const report={status:'running',network,chainId,admin:from,startedAt:new Date().toISOString(),initialNonce:checks.nonce,
    preflight:checks,plannedAddresses:addresses,transactions:[],deployments:{}};
  const persist=()=>{fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,C.stringify(report));};
  persist();
  async function send(step) {
    await C.assertNetwork(provider,network,{execute:true});
    assert.equal(await provider.getTransactionCount(from,'pending'),step.nonce,'Admin nonce changed; stop and inspect the journal');
    const request={to:step.to??undefined,data:step.data,nonce:step.nonce,chainId,value:0n};
    request.gasLimit=(await signer.estimateGas(request))*125n/100n;
    const tx=await signer.sendTransaction(request);
    const entry={label:step.label,hash:tx.hash,nonce:tx.nonce,to:tx.to,dataHash:keccak256(tx.data),status:'submitted'};
    report.transactions.push(entry);persist();
    assert.equal(tx.nonce,step.nonce);assert.equal(keccak256(tx.data),step.dataHash);
    const receipt=await tx.wait();
    Object.assign(entry,{status:receipt.status===1?'confirmed':'reverted',blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed});persist();
    assert.equal(receipt.status,1,step.label+' reverted');
    console.log('confirmed: '+step.label+' ('+tx.hash+')');
    return receipt;
  }
  const marketIds=checks.markets.map(m=>m.marketId);
  async function recheck() {
    const window=await C.assertUpgradeWindow(c,marketIds);
    await C.assertSideBetsInert(c,checks.markets,window.round);
    C.addressEqual(await c.beacon.owner(),d.admin);
    return window;
  }
  try {
    for(const step of steps.filter(s=>s.kind==='deploy')) {
      await send(step);
      report.deployments[step.name]=await verifyDeployment(provider,step,artifacts,d);persist();
    }
    const [engineStep,vaultStep]=steps.filter(s=>s.kind==='call');
    // Engine first: it reads totalAssets(), served by both vault implementations.
    await recheck();
    C.addressEqual(await C.implementationOf(provider,d.engine),d.engineImplementation,'Engine implementation changed meanwhile');
    const configBefore=await C.engineConfig(c);
    await send(engineStep);
    report.engineUpgrade=await verifyEngineUpgrade({provider,d,newImplementation:addresses.RouletteEngine,markets:checks.markets,configBefore});persist();
    await recheck();
    C.addressEqual(await c.beacon.implementation(),d.bankVaultImplementation,'Beacon implementation changed meanwhile');
    const receipt=await send(vaultStep);
    report.vaultUpgrade=await verifyVaultUpgrade({provider,d,newImplementation:addresses.BankVault4626,markets:checks.markets,upgradeBlock:receipt.blockNumber});
    report.status='passed';report.finishedAt=new Date().toISOString();persist();
    return report;
  } catch(error) {
    report.status='failed';report.error=C.redact(error);persist();throw error;
  }
}

function printPlan(plan,d) {
  const out=[];
  out.push('Mask bets v1 — Arbitrum One upgrade plan (DRY RUN, nothing signed or sent)');
  out.push('chain '+plan.chainId+', block '+plan.checks.block+', admin '+d.admin+', admin nonce '+plan.checks.nonce);
  out.push('window: round '+plan.checks.window.round+' '+plan.checks.window.phase+'; side bets disabled, '+plan.checks.sideBets.ticketCount+' tickets, none open, reserves 0');
  for(const b of plan.checks.sideBets.banks)out.push('  market '+b.marketId+' bank '+b.bank+' lock '+b.locked+' = unreleased round stakes');
  out.push('libraries:');
  for(const row of plan.checks.libraries.rows)out.push('  '+row.action.padEnd(6)+' '+row.name.padEnd(26)+' '+(row.current||'-')+'  ('+row.reason+')');
  out.push('transactions (from '+d.admin+'):');
  for(const s of plan.steps) {
    out.push('  #'+s.index+' nonce '+s.nonce+'  '+s.label);
    if(s.kind==='deploy')out.push('      CREATE -> '+s.predicted+'  initcode '+s.dataBytes+' B  keccak '+s.dataHash+'  gas≈'+s.gasEstimate);
    else out.push('      to '+s.to+'  value 0  data '+s.data);
  }
  out.push('Predicted addresses assume these exact nonces: any other admin transaction invalidates the plan, rerun the dry run.');
  out.push('For a multisig: the CREATE steps must still come from '+d.admin+' at these nonces (library addresses are linked into the engine);');
  out.push('only the two upgrade calls (to/value/data above) can be proposed by the owner. --out saves the full calldata.');
  return out.join('\n');
}

function parseArgs(argv) {
  const options={mode:'dry-run',out:null};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--dry-run')options.mode='dry-run';
    else if(arg==='--execute')options.mode='execute';
    else if(arg==='--write-lock')options.mode='write-lock';
    else if(arg==='--out'){options.out=argv[++i];assert(options.out,'--out needs a file');}
    else if(arg==='--help'||arg==='-h')options.mode='help';
    else throw Error('Unknown argument '+arg+' (see --help)');
  }
  if(options.mode==='execute')assert.equal(options.out,null,'--out is a dry-run option');
  return options;
}

async function main() {
  const options=parseArgs(process.argv.slice(2));
  if(options.mode==='help'){console.log(fs.readFileSync(__filename,'utf8').split('\n').slice(1,18).join('\n'));return;}
  if(options.mode==='write-lock') {
    fs.writeFileSync(C.RELEASE_LOCK,C.stringify(C.releaseLock(C.loadArtifacts())));
    console.log('Wrote '+path.relative(C.ROOT,C.RELEASE_LOCK)+'. Commit it only after reviewing the build.');return;
  }
  const d=C.loadMainnetDeployment();
  const provider=new C.ReadOnlyProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
  try {
    if(options.mode==='dry-run') {
      const plan=await planUpgrade({provider,d,network:'mainnet'});
      console.log(printPlan(plan,d));
      if(options.out){fs.writeFileSync(options.out,C.stringify({...plan,steps:plan.steps.map(({expectedRuntime,...s})=>s)}));console.log('Plan with full calldata: '+options.out);}
      console.log('PREFLIGHT PASSED. No transaction sent.');
      return;
    }
    // Execution: a separate provider able to send, with the operator key from the environment only.
    assert.equal(process.env[C.CONFIRM_ENV],C.MAINNET_CONFIRMATION,'Set '+C.CONFIRM_ENV+'='+C.MAINNET_CONFIRMATION+' to execute');
    const {JsonRpcProvider}=require('ethers');
    const writer=new JsonRpcProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
    try {
      const signer=C.operatorSigner(writer,d.admin);
      const reportPath=path.join(UPGRADE_DIR,'mainnet-execution-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
      const report=await executeUpgrade({provider:writer,signer,d,network:'mainnet',reportPath});
      console.log('UPGRADE PASSED. Journal: '+path.relative(C.ROOT,reportPath)+'. Masks remain disabled until mask-bets-v1-activate.cjs.');
      return report;
    } finally {writer.destroy();}
  } finally {provider.destroy();}
}

module.exports={resolveLibraries,buildTransactions,preflight,verifyDeployment,verifyEngineUpgrade,verifyVaultUpgrade,
  planUpgrade,executeUpgrade,printPlan,parseArgs};
if(require.main===module)main().catch(error=>{console.error(C.redact(error));process.exitCode=1;});
