#!/usr/bin/env node
// Mask bets v1 — per-market activation on Arbitrum One, AFTER scripts/mask-bets-v1-mainnet.cjs.
// Calls RouletteEngine.setMaskBetLimits(marketId, maxLegsPerRound, maxLiabilityBps) for the markets given.
// Every value is explicit: there is no default leg cap and no default bps.
//
//   node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --market 2:448:1000    # dry run (default)
//   node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --print-calldata        # to/value/data for a multisig
//   MASK_BETS_V1_MAINNET_CONFIRM=arbitrum-one:42161 MASK_BETS_V1_ADMIN_KEY=… \
//     node scripts/mask-bets-v1-activate.cjs --market 1:448:1000 --execute
//   node scripts/mask-bets-v1-activate.cjs --market 2:0:0 --execute …                  # emergency disable
//
// --market <marketId>:<maxLegsPerRound>:<maxLiabilityBps>
//   maxLegsPerRound   0..65535; 0 disables masks on that market (masks already placed still settle).
//   maxLiabilityBps   0..10000, cap on the round's summed mask payouts in bps of free liquidity (D18: 1000).
// Launch leg cap: 448. The last payout chunk of a lane walks every mask leg (≈ 2.7k gas each): at 448 legs one
// UpkeepScheduler.checkUpkeep(lane) eth_call costs ≈ 1.37–1.38M gas (≈ 1.40M with intrinsic), under ~1.5M;
// 480 legs ≈ 1.45–1.49M, 1 024 legs (D18) ≈ 2.93M. Above 448 the script refuses unless
// --allow-above-launch-cap is given, after confirming the CRE/keeper eth_call gas cap.
// --expected-engine-implementation <address>: the implementation from the upgrade journal (recommended).
//
// RPC: ARBITRUM_RPC_URL, else the public https://arb1.arbitrum.io/rpc.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Interface,getAddress}=require('ethers');
const C=require('./mask-bets-v1-common.cjs');

const ENGINE_INTERFACE=new Interface(C.ENGINE_ABI);

/** Parses `id:legs:bps`, all three mandatory decimal integers within the contract bounds. */
function parseMarketSetting(text) {
  const match=/^(\d+):(\d+):(\d+)$/.exec(String(text||''));
  assert(match,'Expected --market <marketId>:<maxLegsPerRound>:<maxLiabilityBps>, got '+JSON.stringify(text));
  const [marketId,maxLegsPerRound,maxLiabilityBps]=match.slice(1).map(Number);
  assert(marketId>=1&&marketId<=2**32-1,'Invalid market id '+marketId);
  assert(maxLegsPerRound<=C.MAX_MASK_LEGS,'maxLegsPerRound must be ≤ '+C.MAX_MASK_LEGS);
  assert(maxLiabilityBps<=C.MAX_BPS,'maxLiabilityBps must be ≤ '+C.MAX_BPS);
  return {marketId,maxLegsPerRound,maxLiabilityBps};
}

function validateSettings(settings,{allowAboveLaunchCap=false}={}) {
  assert(settings.length>0,'Give at least one --market <id>:<legs>:<bps>; there are no default values');
  const ids=settings.map(s=>s.marketId);
  assert.equal(new Set(ids).size,ids.length,'Each market may appear once');
  for(const s of settings) {
    if(s.maxLegsPerRound>C.LAUNCH_MASK_LEG_CAP)assert(allowAboveLaunchCap,
      'Market '+s.marketId+': '+s.maxLegsPerRound+' legs exceeds the launch cap '+C.LAUNCH_MASK_LEG_CAP+
      ' (checkUpkeep eth_call > ~1.5M gas). Pass --allow-above-launch-cap only after confirming the CRE/keeper eth_call gas cap');
    if(s.maxLegsPerRound>0)assert(s.maxLiabilityBps>0,'Market '+s.marketId+': enabling masks with maxLiabilityBps 0 would reject every mask');
  }
  return settings;
}

/** Read-only checks + simulated calls from the admin. Never signs. */
async function planActivation({provider,d,network,settings,allowAboveLaunchCap=false,expectedEngineImplementation=null}) {
  const chainId=await C.assertNetwork(provider,network);
  validateSettings(settings,{allowAboveLaunchCap});
  const c=C.contracts(provider,d);
  const implementation=await C.implementationOf(provider,d.engine);
  assert.notEqual(C.lower(implementation),C.lower(d.engineImplementation),'Engine still on the pre-mask implementation: run mask-bets-v1-mainnet.cjs first');
  if(expectedEngineImplementation)C.addressEqual(implementation,expectedEngineImplementation,'Engine implementation differs from the upgrade journal');
  const vaultCode=await provider.getCode(await c.beacon.implementation());
  for(const signature of C.REMOVED_VAULT_FUNCTIONS)assert.equal(C.dispatchesSelector(vaultCode,signature),false,'Vault beacon not upgraded yet ('+signature+' still served)');
  assert.equal(await c.engine.hasRole(await c.engine.ENGINE_ROUND_ROLE(),d.admin),true,'Admin lacks ENGINE_ROUND_ROLE');
  const markets=await C.marketsOf(c,d);
  const round=await c.engine.currentGlobalRound();
  const calls=[];
  for(const s of settings) {
    assert(markets.some(m=>m.marketId===s.marketId),'Unknown market '+s.marketId);
    const [maxLegs,maxBps,legs,weighted]=await c.engine.maskBetState(round,s.marketId);
    const data=ENGINE_INTERFACE.encodeFunctionData('setMaskBetLimits',[s.marketId,s.maxLegsPerRound,s.maxLiabilityBps]);
    await provider.call({from:d.admin,to:d.engine,data});
    calls.push({...s,to:getAddress(d.engine),value:'0',data,
      before:{maxLegsPerRound:Number(maxLegs),maxLiabilityBps:Number(maxBps),legCount:legs,weightedPayout:weighted}});
  }
  return {chainId,implementation,round,calls,nonce:await provider.getTransactionCount(d.admin,'latest')};
}

async function executeActivation({provider,signer,d,network,settings,allowAboveLaunchCap,expectedEngineImplementation,reportPath}) {
  await C.assertNetwork(provider,network,{execute:true});
  C.addressEqual(await signer.getAddress(),d.admin,'Signer is not the protocol admin');
  const plan=await planActivation({provider,d,network,settings,allowAboveLaunchCap,expectedEngineImplementation});
  const c=C.contracts(provider,d);
  const report={status:'running',network,admin:d.admin,startedAt:new Date().toISOString(),plan,transactions:[]};
  const persist=()=>{if(!reportPath)return;fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,C.stringify(report));};
  persist();
  try {
    for(const call of plan.calls) {
      await C.assertNetwork(provider,network,{execute:true});
      const nonce=await provider.getTransactionCount(d.admin,'pending');
      const request={to:call.to,data:call.data,nonce,value:0n,chainId:plan.chainId};
      request.gasLimit=(await signer.estimateGas(request))*125n/100n;
      const tx=await signer.sendTransaction(request);
      const entry={marketId:call.marketId,hash:tx.hash,nonce:tx.nonce,status:'submitted'};
      report.transactions.push(entry);persist();
      const receipt=await tx.wait();
      Object.assign(entry,{status:receipt.status===1?'confirmed':'reverted',blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed});persist();
      assert.equal(receipt.status,1,'setMaskBetLimits reverted for market '+call.marketId);
      const events=receipt.logs.filter(l=>C.lower(l.address)===C.lower(d.engine)).map(l=>{try{return ENGINE_INTERFACE.parseLog(l);}catch{return null;}})
        .filter(e=>e?.name==='MaskBetLimitsUpdated');
      assert.equal(events.length,1,'Expected one MaskBetLimitsUpdated event');
      assert.deepEqual(events[0].args.toArray().map(Number),[call.marketId,call.maxLegsPerRound,call.maxLiabilityBps]);
      const [maxLegs,maxBps]=await c.engine.maskBetState(await c.engine.currentGlobalRound(),call.marketId);
      assert.deepEqual([Number(maxLegs),Number(maxBps)],[call.maxLegsPerRound,call.maxLiabilityBps],'Limits not applied on market '+call.marketId);
      entry.after={maxLegsPerRound:Number(maxLegs),maxLiabilityBps:Number(maxBps)};persist();
      console.log('confirmed: market '+call.marketId+' → '+call.maxLegsPerRound+' legs, '+call.maxLiabilityBps+' bps ('+tx.hash+')');
    }
    report.status='passed';report.finishedAt=new Date().toISOString();persist();
    return report;
  } catch(error) {report.status='failed';report.error=C.redact(error);persist();throw error;}
}

function parseArgs(argv) {
  const options={mode:'dry-run',settings:[],allowAboveLaunchCap:false,expectedEngineImplementation:null};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--market')options.settings.push(parseMarketSetting(argv[++i]));
    else if(arg==='--dry-run')options.mode='dry-run';
    else if(arg==='--print-calldata')options.mode='print-calldata';
    else if(arg==='--execute')options.mode='execute';
    else if(arg==='--allow-above-launch-cap')options.allowAboveLaunchCap=true;
    else if(arg==='--expected-engine-implementation')options.expectedEngineImplementation=getAddress(argv[++i]);
    else if(arg==='--help'||arg==='-h')options.mode='help';
    else throw Error('Unknown argument '+arg+' (see --help)');
  }
  if(options.mode!=='help')validateSettings(options.settings,options);
  return options;
}

async function main() {
  const options=parseArgs(process.argv.slice(2));
  if(options.mode==='help'){console.log(fs.readFileSync(__filename,'utf8').split('\n').slice(1,24).join('\n'));return;}
  const d=C.loadMainnetDeployment();
  if(options.mode!=='execute') {
    const provider=new C.ReadOnlyProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
    try {
      const plan=await planActivation({provider,d,network:'mainnet',...options});
      if(options.mode==='print-calldata') {
        console.log(C.stringify(plan.calls.map(({to,value,data,marketId,maxLegsPerRound,maxLiabilityBps})=>({to,value,data,marketId,maxLegsPerRound,maxLiabilityBps}))));
      } else {
        console.log('Mask bets v1 activation (DRY RUN, nothing signed or sent) — engine '+plan.implementation+', round '+plan.round);
        for(const call of plan.calls)console.log('  market '+call.marketId+': '+call.before.maxLegsPerRound+' legs / '+call.before.maxLiabilityBps+' bps → '+
          call.maxLegsPerRound+' legs / '+call.maxLiabilityBps+' bps (simulated from '+d.admin+': ok)');
      }
      return;
    } finally {provider.destroy();}
  }
  assert.equal(process.env[C.CONFIRM_ENV],C.MAINNET_CONFIRMATION,'Set '+C.CONFIRM_ENV+'='+C.MAINNET_CONFIRMATION+' to execute');
  const {JsonRpcProvider}=require('ethers');
  const writer=new JsonRpcProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
  try {
    const signer=C.operatorSigner(writer,d.admin);
    const reportPath=path.join(C.ROOT,'reports/mask-bets-v1','mainnet-activation-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    await executeActivation({provider:writer,signer,d,network:'mainnet',reportPath,...options});
    console.log('ACTIVATION PASSED. Journal: '+path.relative(C.ROOT,reportPath));
  } finally {writer.destroy();}
}

module.exports={parseMarketSetting,validateSettings,planActivation,executeActivation,parseArgs};
if(require.main===module)main().catch(error=>{console.error(C.redact(error));process.exitCode=1;});
