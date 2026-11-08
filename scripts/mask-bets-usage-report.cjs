#!/usr/bin/env node
// Paris spéciaux (masques, BET_MASK = 16) — bilan d'usage EN LECTURE SEULE, à lancer après une semaine de trafic réel.
// Par marché, sur une fenêtre de blocs ou de dates :
//   - jambes masque par tour (moyenne, p95, max) et taux de tours au plafond `maxLegsPerRound` ;
//   - passif masque réservé rapporté à la liquidité libre du vault (moyenne, p95, max), en bps et en part du plafond ;
//   - gaz réel du callback VRF et des transactions de règlement, comparé à reports/mask-bets-v1/vrf-callback-budget.json ;
//   - une recommandation `maxLegs` / `maxBps` selon une règle explicite (RULE ci-dessous, docs/mask-bets-v1-implementation.md),
//     avec les commandes `node scripts/mask-bets-v1-activate.cjs --market id:legs:bps --print-calldata` à faire relire.
// Le script ne signe et n'envoie rien : il n'utilise que eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getLogs,
// eth_call et eth_getTransactionReceipt, via un fournisseur qui refuse toute autre méthode.
//
//   node scripts/mask-bets-usage-report.cjs                                    # 7 derniers jours (défaut)
//   node scripts/mask-bets-usage-report.cjs --from 2026-11-10 --to 2026-11-17 --out /tmp/mask-usage.json
//   node scripts/mask-bets-usage-report.cjs --from-block 522400000 --to-block 524800000
//   node scripts/mask-bets-usage-report.cjs --days 7 --eth-call-gas-cap 5000000   # plafond eth_call CRE/keeper confirmé
//
// Fenêtre : --days <n> | --from <date ISO, UTC> [--to <date ISO>] | --from-block <n> [--to-block <n>] (fin par défaut : dernier bloc).
// Bornes : --chunk-blocks (100000), --max-log-requests (200), --max-receipts (600), --max-state-reads (3000).
// Règle : --eth-call-gas-cap <gaz> (sans lui, jamais plus de 448 jambes), --settlement-gas-limit <gaz> (2500000),
//         --min-mask-rounds <n> (20). Historique des plafonds : --limits-from-block (startBlock du manifeste).
// RPC : ARBITRUM_RPC_URL, sinon le RPC public https://arb1.arbitrum.io/rpc (non archive : la liquidité libre des blocs
// anciens est alors approchée par la valeur actuelle, signalée « approximative »). L'URL n'est jamais écrite.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Interface,AbiCoder,getAddress}=require('ethers');
const C=require('./mask-bets-v1-common.cjs');

const BUDGET_FILE='reports/mask-bets-v1/vrf-callback-budget.json';
const BET_MASK=16n;
const MASK_BITS=(1n<<37n)-1n;
const PRESET_SHIFT=37n;
const PRESET_BITS=(1n<<9n)-1n;
const PAYOUT_NUMERATOR=36n;
const BPS=10000;
const DAY_SECONDS=86400;
const DEFAULT_DAYS=7;
const MIN_CHUNK_BLOCKS=1000;
const LIMITS_CHUNK_BLOCKS=10_000_000;

/**
 * Règle de recommandation (documentée dans docs/mask-bets-v1-implementation.md, « Bilan après une semaine »).
 * Elle ne fait que monter un plafond saturé, par paliers, sous des plafonds de gaz durs ; elle ne baisse que pour
 * revenir sous un plafond de gaz ; elle ne réactive jamais un marché désactivé (0 jambe : décision du propriétaire).
 */
const RULE=Object.freeze({
  gasMarginBps:3000,                 // garder ≥ 30 % de marge sous chaque limite de gaz
  hardLegCeiling:1024,               // jamais au-delà sans nouvelle mesure (point mesuré D18)
  launchLegCap:C.LAUNCH_MASK_LEG_CAP, // 448 : plafond tant que le plafond eth_call CRE/keeper n'est pas confirmé
  legStep:32,                        // valeurs de jambes multiples de 32
  legDemandRatio:0.7,                // monter si p95(jambes) ≥ 70 % du plafond…
  legCapHitRate:0.05,                // …ou si ≥ 5 % des tours avec masques atteignent le plafond
  legGrowth:1.5,                     // palier : × 1,5 au plus
  bpsDemandRatio:0.7,                // monter maxBps seulement si p95(passif / plafond) ≥ 70 %
  bpsGrowth:1.5,
  bpsStep:250,
  maxRecommendedBps:2500,            // au-delà de 25 % de la liquidité libre : décision du propriétaire
  nearCapRatio:0.95,                 // tour « saturé » (proxy des refus MaskLiabilityCapExceeded)
  minMaskRounds:20,                  // en dessous : données insuffisantes, rien ne change
  settlementGasLimit:2_500_000,      // writeGasLimit CRE par défaut (scripts/generateCreLaneConfigs.ts)
});
/**
 * Coût de l'`eth_call` `UpkeepScheduler.checkUpkeep(lane)` sur le dernier bloc d'une lane, en fonction des jambes
 * masque (docs/mask-bets-v1-implementation.md, « Mesures » : 10 lanes / 10 paiements, la configuration la plus chère).
 * Ce coût n'apparaît dans aucun reçu (appel hors chaîne) : il est modélisé, pas observé.
 */
const ETH_CALL_MODEL=Object.freeze({anchorLegs:448,anchorGas:1_380_331,gasPerLeg:3_316,intrinsicGas:25_000,
  source:'checkUpkeep(lane), 10 lanes / 10 paiements : 1 380 331 gaz à 448 jambes, 1 486 443 à 480 (pente 3 316 gaz/jambe), + ≈ 25 k intrinsèque'});

const ENGINE=new Interface([
  'event BetRecorded(uint32 marketId,uint64 localRound,address player,uint256 totalAmount,bytes betData)',
  'event VRFResult(uint64 roundId,uint8 winningNumber,uint8 jackpotNumber)',
  'event PayoutProgress(uint64 globalRoundId,uint32 marketId,uint256 fromCursor,uint256 toCursor,uint256 paidAmount)',
  'event RoundResolved(uint64 roundId)',
  'event MaskBetLimitsUpdated(uint32 marketId,uint32 maxLegsPerRound,uint16 maxLiabilityBps)',
  'function currentGlobalRound() view returns (uint64)',
  'function VRF_CALLBACK_GAS_LIMIT() view returns (uint32)',
  'function maskBetState(uint64,uint32) view returns (uint32 maxLegsPerRound,uint16 maxLiabilityBps,uint256 legCount,uint256 weightedPayout)',
]);
const VAULT=new Interface(['function totalAssets() view returns (uint256)']);
const TOPIC=Object.fromEntries(['BetRecorded','VRFResult','PayoutProgress','RoundResolved','MaskBetLimitsUpdated']
  .map(name=>[name,ENGINE.getEvent(name).topicHash]));
const READ_METHODS=new Set(['eth_chainId','hardhat_metadata','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_call','eth_getTransactionReceipt']);

const hex=n=>'0x'+BigInt(n).toString(16);
const num=value=>Number(BigInt(value));
const posOf=log=>({blockNumber:num(log.blockNumber),logIndex:num(log.logIndex)});
const before=(a,b)=>a.blockNumber<b.blockNumber||(a.blockNumber===b.blockNumber&&a.logIndex<=b.logIndex);
const ceilStep=(value,step)=>Math.ceil(value/step)*step;
const floorStep=(value,step)=>Math.floor(value/step)*step;
const round2=value=>Math.round(value*100)/100;

/** Wraps a JSON-RPC `send` so that only the read methods above can ever reach the node. */
function readOnly(send) {
  return async(method,params)=>{
    assert(READ_METHODS.has(method),'Méthode RPC refusée (lecture seule) : '+method);
    return send(method,params);
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────
function popcount(value) {let count=0;for(let v=value;v!==0n;v&=v-1n)count++;return count;}

/** Mask legs of one `betData` (`(uint256[] betTypes, uint256[] numbers, uint256[] amounts)`), with their reserved payout. */
function decodeMaskLegs(betData) {
  const [betTypes,numbers,amounts]=AbiCoder.defaultAbiCoder().decode(['uint256[]','uint256[]','uint256[]'],betData);
  const legs=[];
  for(let index=0;index<betTypes.length;index++) {
    if(betTypes[index]!==BET_MASK)continue;
    const mask=numbers[index]&MASK_BITS,size=popcount(mask);
    // Le moteur refuse |S| ∉ [2, 35] : un événement ne peut pas porter une taille nulle, la garde évite seulement /0.
    if(size===0)continue;
    legs.push({size,amount:amounts[index],payout:amounts[index]*PAYOUT_NUMERATOR/BigInt(size),
      presetId:Number((numbers[index]>>PRESET_SHIFT)&PRESET_BITS)});
  }
  return legs;
}

/** Mean, nearest-rank p95 and max; `null` fields when there is no sample. */
function summarize(values) {
  if(values.length===0)return {count:0,mean:null,p95:null,max:null};
  const sorted=[...values].sort((a,b)=>a-b);
  const mean=sorted.reduce((sum,v)=>sum+v,0)/sorted.length;
  return {count:sorted.length,mean:round2(mean),p95:sorted[Math.ceil(0.95*sorted.length)-1],max:sorted[sorted.length-1]};
}

function predictEthCallGas(legs,model=ETH_CALL_MODEL) {
  return model.anchorGas+model.intrinsicGas+model.gasPerLeg*(legs-model.anchorLegs);
}
/** Largest leg cap (multiple of `legStep`) allowed by the gas rule. */
function legCeiling({ethCallGasCap=null,rule=RULE,model=ETH_CALL_MODEL}={}) {
  if(!ethCallGasCap)return Math.min(rule.hardLegCeiling,rule.launchLegCap);
  const budget=ethCallGasCap*(BPS-rule.gasMarginBps)/BPS;
  const modelled=model.anchorLegs+Math.floor((budget-model.anchorGas-model.intrinsicGas)/model.gasPerLeg);
  return Math.max(0,Math.min(rule.hardLegCeiling,floorStep(modelled,rule.legStep)));
}

/**
 * Pure recommendation for one market. `current` is the limit in force at the end of the window (null when the
 * engine does not serve masks yet). Returns the values to set, whether they change and every reason, in French.
 */
function recommendMarket({current,maskRounds,legs,capHitRate,capUse,gasFreeze,ethCallGasCap=null,rule=RULE}) {
  const reasons=[];
  if(!current)return {maxLegsPerRound:null,maxLiabilityBps:null,changed:false,
    reasons:['moteur sans paris spéciaux (maskBetState absent) : rien à recommander ; activer d\'abord avec mask-bets-v1-activate.cjs']};
  let maxLegs=current.maxLegsPerRound,maxBps=current.maxLiabilityBps;
  if(maxLegs===0) {
    reasons.push('marché désactivé (0 jambe) : la réactivation est une décision du propriétaire, pas de la règle');
    return {maxLegsPerRound:maxLegs,maxLiabilityBps:maxBps,changed:false,reasons};
  }
  const ceiling=legCeiling({ethCallGasCap,rule});
  const enough=maskRounds>=rule.minMaskRounds;
  if(maxLegs>ceiling) {
    maxLegs=ceiling;
    reasons.push('jambes ramenées à '+ceiling+' : plafond de gaz ('+(ethCallGasCap?'eth_call '+ethCallGasCap+' − 30 %':'448 sans plafond eth_call confirmé')+')');
  } else if(!enough) {
    reasons.push('jambes inchangées : '+maskRounds+' tour(s) avec masques < '+rule.minMaskRounds+' (données insuffisantes)');
  } else {
    const demand=(legs.p95??0)>=rule.legDemandRatio*maxLegs||capHitRate>=rule.legCapHitRate;
    if(!demand)reasons.push('jambes inchangées : p95 '+legs.p95+' < 70 % de '+maxLegs+' et '+round2(capHitRate*100)+' % de tours au plafond < 5 %');
    else if(gasFreeze.length)reasons.push('jambes gelées malgré la demande : '+gasFreeze.join(' ; '));
    else {
      const target=Math.min(ceiling,ceilStep(maxLegs*rule.legGrowth,rule.legStep));
      if(target>maxLegs){reasons.push('jambes '+maxLegs+' → '+target+' : p95 '+legs.p95+', '+round2(capHitRate*100)+' % de tours au plafond');maxLegs=target;}
      else reasons.push('demande de jambes, mais déjà au plafond de gaz ('+ceiling+(ethCallGasCap?'':' ; fournir --eth-call-gas-cap après confirmation du plafond CRE/keeper')+')');
    }
  }
  if(!enough)reasons.push('maxBps inchangé : données insuffisantes');
  else if((capUse.p95??0)>=rule.bpsDemandRatio) {
    const target=Math.min(rule.maxRecommendedBps,ceilStep(maxBps*rule.bpsGrowth,rule.bpsStep));
    if(target>maxBps){reasons.push('maxBps '+maxBps+' → '+target+' : p95 du passif = '+round2(capUse.p95*100)+' % du plafond');maxBps=target;}
    else reasons.push('passif saturé mais maxBps déjà ≥ '+rule.maxRecommendedBps+' : au-delà, décision du propriétaire');
  } else reasons.push('maxBps inchangé : p95 du passif = '+(capUse.p95===null?'—':round2(capUse.p95*100)+' %')+' du plafond (< 70 %)');
  return {maxLegsPerRound:maxLegs,maxLiabilityBps:maxBps,changed:maxLegs!==current.maxLegsPerRound||maxBps!==current.maxLiabilityBps,reasons};
}

function activationCommand(marketId,{maxLegsPerRound,maxLiabilityBps},rule=RULE) {
  return 'node scripts/mask-bets-v1-activate.cjs --market '+marketId+':'+maxLegsPerRound+':'+maxLiabilityBps+' --print-calldata'+
    (maxLegsPerRound>rule.launchLegCap?' --allow-above-launch-cap':'');
}

// ── RPC reads (bounded) ───────────────────────────────────────────────────────────
/** `eth_getLogs` over [fromBlock, toBlock] in chunks; halves the chunk on a range/size error; at most `maxRequests` calls. */
async function getLogsPaged(send,{address,topics,fromBlock,toBlock,chunkBlocks,maxRequests,counter={requests:0}}) {
  const logs=[];
  let chunk=chunkBlocks;
  for(let start=fromBlock;start<=toBlock;) {
    const end=Math.min(toBlock,start+chunk-1);
    assert(counter.requests<maxRequests,'Plus de '+maxRequests+' appels eth_getLogs : réduire la fenêtre ou augmenter --max-log-requests / --chunk-blocks');
    counter.requests++;
    try {
      logs.push(...await send('eth_getLogs',[{address,topics,fromBlock:hex(start),toBlock:hex(end)}]));
      start=end+1;
    } catch(error) {
      const text=[error?.message,error?.error?.message,error?.info?.error?.message].filter(Boolean).join(' ');
      const tooLarge=/range|spans|allowed|narrow|too many|limit|exceed|response size|timeout|10000/i.test(text);
      if(!tooLarge||chunk<=MIN_CHUNK_BLOCKS)throw error;
      chunk=Math.max(MIN_CHUNK_BLOCKS,Math.floor(chunk/2));
    }
  }
  return logs.sort((a,b)=>num(a.blockNumber)-num(b.blockNumber)||num(a.logIndex)-num(b.logIndex));
}

async function blockTimestamp(send,blockNumber) {
  const block=await send('eth_getBlockByNumber',[hex(blockNumber),false]);
  assert(block,'Bloc '+blockNumber+' introuvable');
  return num(block.timestamp);
}
/** First block whose timestamp is ≥ `timestamp` (binary search, ~30 reads). */
async function blockAtOrAfter(send,timestamp,latest) {
  let low=0,high=latest;
  if(await blockTimestamp(send,latest)<timestamp)return latest;
  while(low<high) {
    const mid=Math.floor((low+high)/2);
    if(await blockTimestamp(send,mid)<timestamp)low=mid+1;else high=mid;
  }
  return low;
}

async function call(send,to,iface,fn,args,blockTag='latest') {
  const raw=await send('eth_call',[{to,data:iface.encodeFunctionData(fn,args)},typeof blockTag==='number'?hex(blockTag):blockTag]);
  return iface.decodeFunctionResult(fn,raw);
}
async function tryCall(...args) {
  try {return {ok:true,value:await call(...args)};} catch(error) {return {ok:false,error:C.redact(error)};}
}

/** Arbitrum receipt: total gas, its L1 share and the L2 execution gas that the gas limits bound. */
async function receiptGas(send,hash,cache) {
  if(!cache.has(hash)) {
    const receipt=await send('eth_getTransactionReceipt',[hash]);
    assert(receipt,'Reçu introuvable : '+hash);
    const gasUsed=num(receipt.gasUsed),l1=receipt.gasUsedForL1?num(receipt.gasUsedForL1):0;
    cache.set(hash,{hash,blockNumber:num(receipt.blockNumber),status:num(receipt.status),gasUsed,gasUsedForL1:l1,l2Gas:gasUsed-l1});
  }
  return cache.get(hash);
}

// ── Window ────────────────────────────────────────────────────────────────────────
async function resolveWindow(send,options,latest) {
  if(options.fromBlock!==undefined) {
    const toBlock=options.toBlock??latest;
    assert(options.fromBlock<=toBlock&&toBlock<=latest,'Fenêtre de blocs invalide '+options.fromBlock+'..'+toBlock+' (dernier bloc '+latest+')');
    return {fromBlock:options.fromBlock,toBlock};
  }
  const now=await blockTimestamp(send,latest);
  const toTime=options.to?Math.floor(Date.parse(options.to)/1000):now;
  const fromTime=options.from?Math.floor(Date.parse(options.from)/1000):toTime-(options.days??DEFAULT_DAYS)*DAY_SECONDS;
  assert(Number.isFinite(fromTime)&&Number.isFinite(toTime)&&fromTime<toTime,'Fenêtre de dates invalide');
  const fromBlock=await blockAtOrAfter(send,fromTime,latest);
  const toBlock=toTime>=now?latest:Math.max(fromBlock,(await blockAtOrAfter(send,toTime,latest))-1);
  return {fromBlock,toBlock};
}

// ── Aggregation ───────────────────────────────────────────────────────────────────
/** Per (round, market) activity from `BetRecorded`; stakes are counted up to and including the last mask bet. */
function aggregateBets(betLogs) {
  const rows=new Map();
  for(const log of betLogs) {
    const event=ENGINE.parseLog(log);
    const roundId=Number(event.args.localRound),marketId=Number(event.args.marketId);
    const key=roundId+':'+marketId;
    if(!rows.has(key))rows.set(key,{roundId,marketId,betCount:0,stakes:0n,maskLegs:0,maskWeightedPayout:0n,
      maskStake:0n,stakesAtLastMask:0n,lastMask:null,presets:{}});
    const row=rows.get(key);
    row.betCount++;row.stakes+=event.args.totalAmount;
    const legs=decodeMaskLegs(event.args.betData);
    if(legs.length===0)continue;
    for(const leg of legs) {
      row.maskLegs++;row.maskWeightedPayout+=leg.payout;row.maskStake+=leg.amount;
      row.presets[leg.presetId]=(row.presets[leg.presetId]||0)+1;
    }
    row.lastMask={...posOf(log),transactionHash:log.transactionHash};
    row.stakesAtLastMask=row.stakes;
  }
  return rows;
}

/** Limit in force at `position`, replaying `MaskBetLimitsUpdated` (masks ship disabled: 0/0 before any update). */
function limitAt(updates,marketId,position) {
  let limit={maxLegsPerRound:0,maxLiabilityBps:0};
  for(const update of updates)if(update.marketId===marketId&&before(update,position))
    limit={maxLegsPerRound:update.maxLegsPerRound,maxLiabilityBps:update.maxLiabilityBps};
  return limit;
}

function gasSummary(rows,limit) {
  const l2=summarize(rows.map(r=>r.l2Gas));
  return {...l2,limit,maxShareOfLimit:l2.max===null?null:round2(l2.max/limit*100)};
}

// ── Report ────────────────────────────────────────────────────────────────────────
/**
 * Collects everything from the chain through `send` (read-only) and returns the full report object.
 * `d` is the deployment ({engine, banks, startBlock}); `budget` is vrf-callback-budget.json.
 */
async function buildReport({send:rawSend,d,budget,options={},network='mainnet',rule=RULE}) {
  const send=readOnly(rawSend);
  const chainId=await C.assertNetwork({send},network);
  const latest=num(await send('eth_blockNumber',[]));
  const window=await resolveWindow(send,options,latest);
  // Le RPC public limite à 100 000 blocs une requête à plusieurs topics ; une requête à un seul topic passe en grand.
  const bounds={chunkBlocks:options.chunkBlocks??100_000,maxRequests:options.maxLogRequests??200,counter:{requests:0}};
  const warnings=[];
  const markets=d.banks.map((bank,index)=>({marketId:index+1,bank:getAddress(bank)}));

  // Logs : jeu (fenêtre) + historique complet des plafonds (filtré par topic, donc peu de résultats).
  const windowLogs=await getLogsPaged(send,{...bounds,address:d.engine,fromBlock:window.fromBlock,toBlock:window.toBlock,
    topics:[[TOPIC.BetRecorded,TOPIC.VRFResult,TOPIC.PayoutProgress,TOPIC.RoundResolved]]});
  const limitLogs=await getLogsPaged(send,{...bounds,chunkBlocks:Math.max(bounds.chunkBlocks,LIMITS_CHUNK_BLOCKS),address:d.engine,fromBlock:Math.min(options.limitsFromBlock??d.startBlock,window.toBlock),
    toBlock:window.toBlock,topics:[TOPIC.MaskBetLimitsUpdated]});
  const updates=limitLogs.map(log=>{const e=ENGINE.parseLog(log);return {...posOf(log),marketId:Number(e.args.marketId),
    maxLegsPerRound:Number(e.args.maxLegsPerRound),maxLiabilityBps:Number(e.args.maxLiabilityBps),transactionHash:log.transactionHash};});
  const byTopic=topic=>windowLogs.filter(log=>log.topics[0]===topic);
  const rows=aggregateBets(byTopic(TOPIC.BetRecorded));

  // Moteur : sert-il maskBetState ? Plafonds en vigueur à la fin de la fenêtre.
  const currentRound=Number((await call(send,d.engine,ENGINE,'currentGlobalRound',[]))[0]);
  const probe=await tryCall(send,d.engine,ENGINE,'maskBetState',[currentRound,1]);
  const supportsMasks=probe.ok;
  const vrfLimitRead=await tryCall(send,d.engine,ENGINE,'VRF_CALLBACK_GAS_LIMIT',[]);
  const vrfCallbackGasLimit=vrfLimitRead.ok?Number(vrfLimitRead.value[0]):budget.gasLimit;
  if(!supportsMasks)warnings.push('Le moteur ne sert pas maskBetState : upgrade des paris spéciaux non exécuté, aucune donnée de masque possible.');

  // Paris spéciaux : compteurs exacts du moteur (jamais effacés) et liquidité libre au dernier pari masque.
  const maskRows=[...rows.values()].filter(r=>r.maskLegs>0);
  const maxStateReads=options.maxStateReads??3000;
  assert(maskRows.length*2<=maxStateReads,maskRows.length+' (tour, marché) avec masques : plus de '+maxStateReads+' lectures, réduire la fenêtre ou augmenter --max-state-reads');
  const latestAssets=new Map();
  for(const row of maskRows) {
    const market=markets.find(m=>m.marketId===row.marketId);
    assert(market,'Marché '+row.marketId+' absent du manifeste');
    if(supportsMasks) {
      const [,,legCount,weighted]=await call(send,d.engine,ENGINE,'maskBetState',[row.roundId,row.marketId]);
      if(Number(legCount)!==row.maskLegs||weighted!==row.maskWeightedPayout)
        warnings.push('Tour '+row.roundId+' marché '+row.marketId+' : événements ('+row.maskLegs+' jambes, '+row.maskWeightedPayout+
          ') ≠ moteur ('+legCount+', '+weighted+') ; valeurs du moteur retenues (fenêtre coupant le tour ?)');
      row.maskLegs=Number(legCount);row.maskWeightedPayout=weighted;
    }
    const atBlock=await tryCall(send,market.bank,VAULT,'totalAssets',[],row.lastMask.blockNumber);
    let totalAssets;
    if(atBlock.ok){totalAssets=atBlock.value[0];row.freeLiquiditySource='archive';}
    else {
      if(!latestAssets.has(market.bank))latestAssets.set(market.bank,(await call(send,market.bank,VAULT,'totalAssets',[]))[0]);
      totalAssets=latestAssets.get(market.bank);row.freeLiquiditySource='latest-approximation';
    }
    // Même formule que RouletteEngine._recordBetInternal, état après le bloc du dernier pari masque :
    // totalAssets() (verrou du round déduit) + mises du round jusqu'à ce pari.
    row.freeLiquidity=totalAssets+row.stakesAtLastMask;
    row.limit=limitAt(updates,row.marketId,row.lastMask);
    row.liabilityBps=row.freeLiquidity>0n?Number(row.maskWeightedPayout*BigInt(BPS)*100n/row.freeLiquidity)/100:null;
    row.capUse=row.limit.maxLiabilityBps>0&&row.liabilityBps!==null?round2(row.liabilityBps/row.limit.maxLiabilityBps*100)/100:null;
    row.atLegCap=row.limit.maxLegsPerRound>0&&row.maskLegs>=row.limit.maxLegsPerRound;
  }
  if(maskRows.some(r=>r.freeLiquiditySource!=='archive'))warnings.push('RPC non archive : liquidité libre de '+
    maskRows.filter(r=>r.freeLiquiditySource!=='archive').length+' tour(s) approchée par totalAssets() actuel. Relancer avec un ARBITRUM_RPC_URL archive pour des bps exacts.');

  // Gaz : callback VRF (tx qui émet VRFResult) et règlement (tx PayoutProgress / RoundResolved) des tours.
  const maskRounds=new Set(maskRows.map(r=>r.roundId));
  const vrfTx=new Map(byTopic(TOPIC.VRFResult).map(log=>[Number(ENGINE.parseLog(log).args.roundId),log.transactionHash]));
  const settlementTx=new Map();
  for(const log of [...byTopic(TOPIC.PayoutProgress),...byTopic(TOPIC.RoundResolved)]) {
    const e=ENGINE.parseLog(log);const roundId=Number(e.name==='PayoutProgress'?e.args.globalRoundId:e.args.roundId);
    if(!settlementTx.has(roundId))settlementTx.set(roundId,new Set());
    settlementTx.get(roundId).add(log.transactionHash);
  }
  const maxReceipts=options.maxReceipts??600,cache=new Map();
  const ordered=[...new Set([...vrfTx.keys(),...settlementTx.keys()])].sort((a,b)=>b-a);
  const roundsForGas=[...ordered.filter(r=>maskRounds.has(r)),...ordered.filter(r=>!maskRounds.has(r))];
  const gasRounds=[];
  let receiptsLeft=maxReceipts,skipped=0;
  for(const roundId of roundsForGas) {
    const hashes=[vrfTx.get(roundId),...(settlementTx.get(roundId)||[])].filter(h=>h&&!cache.has(h));
    if(hashes.length>receiptsLeft){skipped++;continue;}
    receiptsLeft-=hashes.length;
    const vrf=vrfTx.has(roundId)?await receiptGas(send,vrfTx.get(roundId),cache):null;
    const settlement=[];
    for(const hash of settlementTx.get(roundId)||[])if(hash!==vrf?.hash)settlement.push(await receiptGas(send,hash,cache));
    gasRounds.push({roundId,withMasks:maskRounds.has(roundId),vrf,settlement,
      settlementMaxTx:settlement.length?Math.max(...settlement.map(s=>s.l2Gas)):null,
      settlementTotal:settlement.reduce((sum,s)=>sum+s.l2Gas,0)});
  }
  if(skipped)warnings.push(skipped+' tour(s) sans mesure de gaz (--max-receipts '+maxReceipts+' atteint ; les tours avec masques passent en premier).');
  const settlementGasLimit=options.settlementGasLimit??rule.settlementGasLimit;
  const vrfOf=withMasks=>gasRounds.filter(g=>g.withMasks===withMasks&&g.vrf).map(g=>g.vrf);
  const settleOf=withMasks=>gasRounds.filter(g=>g.withMasks===withMasks).flatMap(g=>g.settlement);
  const gas={
    vrfCallback:{withMasks:gasSummary(vrfOf(true),vrfCallbackGasLimit),withoutMasks:gasSummary(vrfOf(false),vrfCallbackGasLimit),
      budgetCallbackGasWithMasks:Number(budget.callbackGasWithMasks),budgetCallbackGasWithoutMasks:Number(budget.callbackGasWithoutMasks),
      note:'Gaz L2 de la transaction du coordinateur (gasUsed − gasUsedForL1) : majorant du callback, qui y est inclus.'},
    settlement:{withMasks:gasSummary(settleOf(true),settlementGasLimit),withoutMasks:gasSummary(settleOf(false),settlementGasLimit),
      perRoundTotalWithMasks:summarize(gasRounds.filter(g=>g.withMasks&&g.settlement.length).map(g=>g.settlementTotal)),
      note:'Gaz L2 par transaction PayoutProgress / RoundResolved, comparé au writeGasLimit CRE.'},
    ethCallModel:{...ETH_CALL_MODEL,budgetPreviewAtCap:Number(budget.previewPayoutBundleEthCallGasAtCap),budgetMaskLegsAtCap:budget.maskLegsPerMarket,
      ethCallGasCap:options.ethCallGasCap??null,legCeiling:legCeiling({ethCallGasCap:options.ethCallGasCap,rule})},
    receipts:cache.size,
  };
  const margin=(BPS-rule.gasMarginBps)/BPS;
  const gasFreeze=[];
  const vrfObserved=gas.vrfCallback.withMasks.max??gas.vrfCallback.withoutMasks.max;
  if(vrfObserved!==null&&vrfObserved>margin*vrfCallbackGasLimit)gasFreeze.push('callback VRF '+vrfObserved+' gaz > 70 % de '+vrfCallbackGasLimit);
  const settleObserved=gas.settlement.withMasks.max;
  if(settleObserved!==null&&settleObserved>margin*settlementGasLimit)gasFreeze.push('règlement '+settleObserved+' gaz > 70 % de '+settlementGasLimit);
  if(gas.settlement.withMasks.count&&gasRounds.some(g=>g.withMasks&&g.settlement.some(s=>s.status!==1)))gasFreeze.push('transaction de règlement en échec sur un tour avec masques');
  gas.freeze=gasFreeze;

  // Par marché : statistiques + recommandation.
  const reportMarkets=[];
  for(const market of markets) {
    let current=null;
    if(supportsMasks) {
      const [maxLegs,maxBps]=await call(send,d.engine,ENGINE,'maskBetState',[currentRound,market.marketId],window.toBlock===latest?'latest':window.toBlock)
        .catch(async()=>call(send,d.engine,ENGINE,'maskBetState',[currentRound,market.marketId]));
      current={maxLegsPerRound:Number(maxLegs),maxLiabilityBps:Number(maxBps)};
    }
    const active=[...rows.values()].filter(r=>r.marketId===market.marketId);
    const withMasks=active.filter(r=>r.maskLegs>0);
    const capHits=withMasks.filter(r=>r.atLegCap).length;
    const capHitRate=withMasks.length?capHits/withMasks.length:0;
    const legs={...summarize(withMasks.map(r=>r.maskLegs)),meanOverActiveRounds:active.length?round2(withMasks.reduce((s,r)=>s+r.maskLegs,0)/active.length):null};
    const liabilityBps=summarize(withMasks.filter(r=>r.liabilityBps!==null).map(r=>r.liabilityBps));
    const capUse=summarize(withMasks.filter(r=>r.capUse!==null).map(r=>r.capUse));
    const nearCap=withMasks.filter(r=>r.capUse!==null&&r.capUse>=rule.nearCapRatio).length;
    const presets={};
    for(const r of withMasks)for(const [id,count] of Object.entries(r.presets))presets[id]=(presets[id]||0)+count;
    const recommendation=recommendMarket({current,maskRounds:withMasks.length,legs,capHitRate,capUse,gasFreeze,ethCallGasCap:options.ethCallGasCap,rule});
    if(recommendation.maxLegsPerRound!==null)recommendation.predictedEthCallGas=predictEthCallGas(recommendation.maxLegsPerRound);
    if(withMasks.some(r=>r.freeLiquiditySource!=='archive'))recommendation.reasons.push('attention : bps calculés sur une liquidité libre approchée');
    reportMarkets.push({...market,current,
      activity:{roundsWithBets:active.length,roundsWithMasks:withMasks.length,maskLegs:withMasks.reduce((s,r)=>s+r.maskLegs,0),presets},
      legsPerRound:legs,legCap:{roundsAtCap:capHits,rate:round2(capHitRate*100)/100},
      liability:{bpsOfFreeLiquidity:liabilityBps,shareOfCap:capUse,roundsNearCap:nearCap,
        maxWeightedPayout:withMasks.reduce((m,r)=>r.maskWeightedPayout>m?r.maskWeightedPayout:m,0n)},
      refusals:{measurable:false,roundsAtLegCap:capHits,roundsNearLiabilityCap:nearCap,
        note:'MaskLegCapExceeded / MaskLiabilityCapExceeded / MaskBetsDisabled sont des reverts : aucun log, et un portefeuille '+
          'refuse en général d\'envoyer une transaction dont estimateGas échoue. Les refus ne se lisent donc pas par getLogs ; '+
          'proxys : tours au plafond de jambes et tours ≥ 95 % du plafond de passif. Les tentatives échouées côté frontend '+
          'remontent par /api/logs/bets/attempt (Telegram).'},
      recommendation,
      rounds:withMasks.map(r=>({roundId:r.roundId,legs:r.maskLegs,weightedPayout:r.maskWeightedPayout,freeLiquidity:r.freeLiquidity,
        freeLiquiditySource:r.freeLiquiditySource,liabilityBps:r.liabilityBps,shareOfCap:r.capUse,limit:r.limit,atLegCap:r.atLegCap,lastMaskBlock:r.lastMask.blockNumber}))});
  }
  const commands=reportMarkets.filter(m=>m.recommendation.changed).map(m=>activationCommand(m.marketId,m.recommendation,rule));
  const hasData=maskRows.length>0;
  if(!hasData)warnings.push('Aucune jambe de pari spécial dans la fenêtre : aucune donnée, aucun réglage à changer.');
  return {
    kind:'mask-bets-usage-report',generatedAt:new Date().toISOString(),network:d.label??network,chainId,
    rpc:process.env[C.RPC_ENV]?C.RPC_ENV:'public',
    window:{...window,fromTimestamp:await blockTimestamp(send,window.fromBlock),toTimestamp:await blockTimestamp(send,window.toBlock),latestBlock:latest},
    sources:{chain:'eth_getLogs (BetRecorded, VRFResult, PayoutProgress, RoundResolved, MaskBetLimitsUpdated) + maskBetState / totalAssets (eth_call) + reçus',
      logRequests:bounds.counter.requests,subgraph:'non utilisé'},
    engine:{address:d.engine,supportsMasks,currentRound,vrfCallbackGasLimit},
    hasData,rule,gas,markets:reportMarkets,commands,warnings,
  };
}

// ── Console ───────────────────────────────────────────────────────────────────────
const fmt=value=>value===null||value===undefined?'—':String(value);
function formatReport(report) {
  const lines=[];
  const date=ts=>new Date(ts*1000).toISOString().replace('.000Z','Z');
  lines.push('Bilan des paris spéciaux (lecture seule, rien n\'est signé ni envoyé) — '+report.network);
  lines.push('Fenêtre : blocs '+report.window.fromBlock+' → '+report.window.toBlock+' ('+date(report.window.fromTimestamp)+' → '+date(report.window.toTimestamp)+')');
  lines.push('Moteur : '+report.engine.address+(report.engine.supportsMasks?' (paris spéciaux servis)':' (sans paris spéciaux)')+', round courant '+report.engine.currentRound);
  const g=report.gas;
  lines.push('');
  lines.push('Gaz du callback VRF (L2, tx du coordinateur), limite '+report.engine.vrfCallbackGasLimit+', budget mesuré avec masques '+g.vrfCallback.budgetCallbackGasWithMasks+' :');
  for(const [label,s] of [['avec masques',g.vrfCallback.withMasks],['sans masques',g.vrfCallback.withoutMasks]])
    lines.push('  '+label+' : '+s.count+' tour(s), moyenne '+fmt(s.mean)+', p95 '+fmt(s.p95)+', max '+fmt(s.max)+(s.max===null?'':' ('+s.maxShareOfLimit+' % de la limite)'));
  lines.push('Gaz du règlement (L2 par transaction), limite '+g.settlement.withMasks.limit+' :');
  for(const [label,s] of [['avec masques',g.settlement.withMasks],['sans masques',g.settlement.withoutMasks]])
    lines.push('  '+label+' : '+s.count+' tx, moyenne '+fmt(s.mean)+', p95 '+fmt(s.p95)+', max '+fmt(s.max)+(s.max===null?'':' ('+s.maxShareOfLimit+' % de la limite)'));
  lines.push('eth_call checkUpkeep (modèle, non observable) : plafond eth_call '+fmt(g.ethCallModel.ethCallGasCap)+', plafond de jambes autorisé '+g.ethCallModel.legCeiling);
  if(g.freeze.length)lines.push('GEL des hausses de jambes : '+g.freeze.join(' ; '));
  for(const m of report.markets) {
    lines.push('');
    lines.push('Marché '+m.marketId+' ('+m.bank+') — plafonds actuels : '+(m.current?m.current.maxLegsPerRound+' jambes / '+m.current.maxLiabilityBps+' bps':'—'));
    lines.push('  tours avec paris : '+m.activity.roundsWithBets+', avec masques : '+m.activity.roundsWithMasks+', jambes : '+m.activity.maskLegs);
    if(m.activity.roundsWithMasks===0)lines.push('  aucune donnée de paris spéciaux sur ce marché');
    else {
      lines.push('  jambes par tour : moyenne '+m.legsPerRound.mean+', p95 '+m.legsPerRound.p95+', max '+m.legsPerRound.max+' ; tours au plafond : '+m.legCap.roundsAtCap+' ('+round2(m.legCap.rate*100)+' %)');
      const l=m.liability;
      lines.push('  passif / liquidité libre (bps) : moyenne '+fmt(l.bpsOfFreeLiquidity.mean)+', p95 '+fmt(l.bpsOfFreeLiquidity.p95)+', max '+fmt(l.bpsOfFreeLiquidity.max)+
        ' ; part du plafond p95 '+(l.shareOfCap.p95===null?'—':round2(l.shareOfCap.p95*100)+' %')+' ; tours ≥ 95 % du plafond : '+l.roundsNearCap);
    }
    lines.push('  refus pour plafond : non mesurables on-chain (reverts sans log) ; proxys ci-dessus');
    const r=m.recommendation;
    lines.push('  recommandation : '+(r.maxLegsPerRound===null?'aucune':r.maxLegsPerRound+' jambes / '+r.maxLiabilityBps+' bps'+(r.changed?' (CHANGEMENT)':' (inchangé)')));
    for(const reason of r.reasons)lines.push('    - '+reason);
  }
  lines.push('');
  if(report.commands.length) {
    lines.push('Commandes à faire relire puis appliquer par l\'admin (dry run / calldata multisig, rien n\'est envoyé ici) :');
    for(const command of report.commands)lines.push('  '+command);
  } else lines.push('Aucune commande : réglages inchangés.');
  for(const warning of report.warnings)lines.push('Avertissement : '+warning);
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options={};
  const integer=(name,value)=>{assert(/^\d+$/.test(String(value)),name+' attend un entier, reçu '+JSON.stringify(value));return Number(value);};
  const date=(name,value)=>{assert(value&&Number.isFinite(Date.parse(value)),name+' attend une date ISO, reçu '+JSON.stringify(value));return value;};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i],next=()=>argv[++i];
    if(arg==='--from-block')options.fromBlock=integer(arg,next());
    else if(arg==='--to-block')options.toBlock=integer(arg,next());
    else if(arg==='--from')options.from=date(arg,next());
    else if(arg==='--to')options.to=date(arg,next());
    else if(arg==='--days')options.days=integer(arg,next());
    else if(arg==='--out')options.out=next();
    else if(arg==='--chunk-blocks')options.chunkBlocks=integer(arg,next());
    else if(arg==='--max-log-requests')options.maxLogRequests=integer(arg,next());
    else if(arg==='--max-receipts')options.maxReceipts=integer(arg,next());
    else if(arg==='--max-state-reads')options.maxStateReads=integer(arg,next());
    else if(arg==='--eth-call-gas-cap')options.ethCallGasCap=integer(arg,next());
    else if(arg==='--settlement-gas-limit')options.settlementGasLimit=integer(arg,next());
    else if(arg==='--min-mask-rounds')options.minMaskRounds=integer(arg,next());
    else if(arg==='--limits-from-block')options.limitsFromBlock=integer(arg,next());
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw Error('Argument inconnu '+arg+' (voir --help)');
  }
  const byBlock=options.fromBlock!==undefined||options.toBlock!==undefined;
  const byDate=options.from!==undefined||options.to!==undefined||options.days!==undefined;
  assert(!(byBlock&&byDate),'Choisir une fenêtre en blocs OU en dates, pas les deux');
  assert(options.toBlock===undefined||options.fromBlock!==undefined,'--to-block demande --from-block');
  assert(!(options.days!==undefined&&options.from!==undefined),'--days et --from s\'excluent');
  assert(options.days===undefined||options.days>0,'--days doit être > 0');
  assert(options.chunkBlocks===undefined||options.chunkBlocks>=MIN_CHUNK_BLOCKS,'--chunk-blocks doit être ≥ '+MIN_CHUNK_BLOCKS);
  return options;
}

function loadBudget(root=C.ROOT) {return JSON.parse(fs.readFileSync(path.join(root,BUDGET_FILE),'utf8'));}
function loadDeployment(root=C.ROOT) {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'deployments/arbitrum-one.json'),'utf8'));
  return {label:'arbitrum-one',engine:getAddress(manifest.addresses.engine),banks:manifest.addresses.banks.map(b=>getAddress(b)),startBlock:manifest.startBlock};
}

async function main() {
  const options=parseArgs(process.argv.slice(2));
  if(options.help){console.log(fs.readFileSync(__filename,'utf8').split('\n').slice(1,24).join('\n'));return;}
  const rule=options.minMaskRounds===undefined?RULE:Object.freeze({...RULE,minMaskRounds:options.minMaskRounds});
  const provider=new C.ReadOnlyProvider(C.rpcUrl(),C.MAINNET_CHAIN_ID,{staticNetwork:true});
  try {
    const report=await buildReport({send:(method,params)=>provider.send(method,params),d:loadDeployment(),budget:loadBudget(),options,rule});
    console.log(formatReport(report));
    if(options.out) {
      fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});
      fs.writeFileSync(options.out,C.stringify(report));
      console.log('JSON : '+options.out);
    }
  } finally {provider.destroy();}
}

module.exports={RULE,ETH_CALL_MODEL,TOPIC,ENGINE,VAULT,BET_MASK,decodeMaskLegs,summarize,predictEthCallGas,legCeiling,recommendMarket,
  activationCommand,getLogsPaged,blockAtOrAfter,aggregateBets,limitAt,buildReport,formatReport,parseArgs,loadBudget,loadDeployment,readOnly};
if(require.main===module)main().catch(error=>{console.error(C.redact(error));process.exitCode=1;});
