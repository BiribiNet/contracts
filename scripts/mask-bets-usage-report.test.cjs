// Tests hors ligne du bilan des paris spéciaux (aucun réseau, aucune clé) : une fausse chaîne JSON-RPC sert des
// événements, des eth_call et des reçus construits ici avec l'ABI du moteur.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AbiCoder,getAddress}=require('ethers');
const R=require('./mask-bets-usage-report.cjs');

const ENGINE_ADDRESS=getAddress('0x'+'e1'.repeat(20));
const BANKS=['0x'+'b1'.repeat(20),'0x'+'b2'.repeat(20),'0x'+'b3'.repeat(20)].map(a=>getAddress(a));
const DEPLOYMENT={label:'test',engine:ENGINE_ADDRESS,banks:BANKS,startBlock:1};
const BUDGET=R.loadBudget();
const GENESIS_TIME=1_700_000_000;
const hex=n=>'0x'+BigInt(n).toString(16);
const legNumber=(mask,presetId=0)=>BigInt(mask)|BigInt(presetId)<<37n;
const betData=legs=>AbiCoder.defaultAbiCoder().encode(['uint256[]','uint256[]','uint256[]'],
  [legs.map(l=>l.type),legs.map(l=>l.number),legs.map(l=>l.amount)]);

/** Fake Arbitrum node: blocks every 10 s, eth_call at a block older than `archiveFrom` fails like a pruned node. */
function fakeChain({latest=1000,archiveFrom=0,supportsMasks=true,rangeLimit=Infinity}={}) {
  const logs=[],receipts=new Map(),limits=new Map(),maskState=new Map(),totalAssets=new Map(),methods=[];
  let logIndex=0,txCounter=0;
  const started=new Set();
  const chain={latest,logs,methods,receipts,limits,maskState,totalAssets,currentRound:500,
    emit(name,values,blockNumber,transactionHash){
      const {data,topics}=R.ENGINE.encodeEventLog(R.ENGINE.getEvent(name),values);
      const hash=transactionHash??'0x'+(++txCounter).toString(16).padStart(64,'0');
      logs.push({address:ENGINE_ADDRESS,data,topics,blockNumber:hex(blockNumber),logIndex:hex(logIndex++),transactionHash:hash});
      return hash;
    },
    setLimits(marketId,legs,bps,blockNumber){chain.emit('MaskBetLimitsUpdated',[marketId,legs,bps],blockNumber);limits.set(marketId,[legs,bps]);},
    bet(roundId,marketId,legs,blockNumber){
      if(!started.has(roundId)){started.add(roundId);chain.emit('RoundCountdownStarted',[roundId,marketId,GENESIS_TIME+blockNumber*10+300],blockNumber);}
      const total=legs.reduce((s,l)=>s+l.amount,0n);
      chain.emit('BetRecorded',[marketId,roundId,'0x'+'aa'.repeat(20),total,betData(legs)],blockNumber);
      const key=roundId+':'+marketId,state=maskState.get(key)??{legs:0n,weighted:0n};
      for(const leg of legs)if(leg.type===16n){
        let size=0n;for(let m=leg.number&((1n<<37n)-1n);m;m&=m-1n)size++;
        state.legs++;state.weighted+=leg.amount*36n/size;
      }
      maskState.set(key,state);
    },
    settle(roundId,marketId,blockNumber,{vrfGas=400_000,settleGas=600_000,l1=50_000,status=1}={}){
      const vrf=chain.emit('VRFResult',[roundId,7,9],blockNumber);
      receipts.set(vrf,{gasUsed:hex(vrfGas),gasUsedForL1:hex(l1),blockNumber:hex(blockNumber),status:hex(1)});
      const payout=chain.emit('PayoutProgress',[roundId,marketId,0,1,1],blockNumber+1);
      chain.emit('RoundResolved',[roundId],blockNumber+1,payout);
      receipts.set(payout,{gasUsed:hex(settleGas),gasUsedForL1:hex(l1),blockNumber:hex(blockNumber+1),status:hex(status)});
    },
  };
  const selector=name=>R.ENGINE.getFunction(name).selector;
  chain.send=async(method,params)=>{
    methods.push(method);
    if(method==='eth_chainId')return '0xa4b1';
    if(method==='hardhat_metadata')throw Error('the method hardhat_metadata does not exist');
    if(method==='eth_blockNumber')return hex(latest);
    if(method==='eth_getBlockByNumber'){const n=Number(BigInt(params[0]));return n<=latest?{number:hex(n),timestamp:hex(GENESIS_TIME+n*10)}:null;}
    if(method==='eth_getLogs'){
      const [{address,topics,fromBlock,toBlock}]=params,from=Number(BigInt(fromBlock)),to=Number(BigInt(toBlock));
      if(to-from+1>rangeLimit)throw Object.assign(Error('could not coalesce error'),{error:{message:'query spans '+(to-from+1)+' blocks, but only '+rangeLimit+' are allowed'}});
      const wanted=[].concat(topics[0]);
      return logs.filter(l=>l.address===address&&wanted.includes(l.topics[0])&&Number(BigInt(l.blockNumber))>=from&&Number(BigInt(l.blockNumber))<=to);
    }
    if(method==='eth_getTransactionReceipt')return receipts.get(params[0])??null;
    if(method==='eth_call'){
      const [{to,data},blockTag]=params;
      if(blockTag!=='latest'&&Number(BigInt(blockTag))<archiveFrom)throw Error('missing trie node 1234 (path ) state 0x…');
      if(BANKS.includes(getAddress(to))){
        const marketId=BANKS.indexOf(getAddress(to))+1;
        return R.VAULT.encodeFunctionResult('totalAssets',[totalAssets.get(marketId)??0n]);
      }
      if(data.startsWith(selector('currentGlobalRound')))return R.ENGINE.encodeFunctionResult('currentGlobalRound',[chain.currentRound]);
      if(data.startsWith(selector('VRF_CALLBACK_GAS_LIMIT')))return R.ENGINE.encodeFunctionResult('VRF_CALLBACK_GAS_LIMIT',[2_500_000]);
      if(data.startsWith(selector('maskBetState'))){
        if(!supportsMasks)throw Error('execution reverted');
        const [roundId,marketId]=R.ENGINE.decodeFunctionData('maskBetState',data).map(Number);
        const [legs,bps]=limits.get(marketId)??[0,0],state=maskState.get(roundId+':'+marketId)??{legs:0n,weighted:0n};
        return R.ENGINE.encodeFunctionResult('maskBetState',[legs,bps,state.legs,state.weighted]);
      }
      throw Error('execution reverted');
    }
    throw Error('Unexpected RPC method '+method);
  };
  return chain;
}

const UNIT=1_000_000n; // actif à 6 décimales
const maskLeg=(amount=UNIT,mask=0b11n,presetId=3)=>({type:16n,number:legNumber(mask,presetId),amount});
const straight=(amount=UNIT)=>({type:1n,number:17n,amount});

test('should decode only BET_MASK legs and reserve floor(amount × 36 / |S|) when the payload is mixed',()=>{
  const legs=R.decodeMaskLegs(betData([straight(),maskLeg(7n,0b111n,5),maskLeg(10n*UNIT,(1n<<35n)-1n)]));
  assert.equal(legs.length,2);
  assert.deepEqual(legs.map(l=>[l.size,l.payout,l.presetId]),[[3,84n,5],[35,10n*UNIT*36n/35n,3]]);
  assert.equal(R.decodeMaskLegs(betData([straight()])).length,0);
});

test('should return mean, nearest-rank p95 and max, and nulls when there is no sample',()=>{
  assert.deepEqual(R.summarize([]),{count:0,mean:null,p95:null,max:null});
  const values=Array.from({length:20},(_v,index)=>index+1);
  assert.deepEqual(R.summarize(values),{count:20,mean:10.5,p95:19,max:20});
});

test('should cap legs at 448 without a confirmed eth_call cap and never above 1 024',()=>{
  assert.equal(R.legCeiling(),448);
  // 30 % de marge : 0,7 × 2 M = 1,4 M < 1,405 M (448 jambes + intrinsèque) ⇒ 416.
  assert.equal(R.legCeiling({ethCallGasCap:2_000_000}),416);
  assert.equal(R.legCeiling({ethCallGasCap:50_000_000}),1024);
  assert.equal(R.legCeiling({ethCallGasCap:10_000}),0);
  assert(R.predictEthCallGas(448)<1_500_000&&R.predictEthCallGas(480)>R.predictEthCallGas(448));
});

const demand={maskRounds:30,legs:{p95:400},capHitRate:0.2,capUse:{p95:0.2},gasFreeze:[]};
test('should keep the launch cap when legs saturate but no eth_call cap is confirmed',()=>{
  const r=R.recommendMarket({...demand,current:{maxLegsPerRound:448,maxLiabilityBps:1000}});
  assert.equal(r.changed,false);
  assert.match(r.reasons.join('\n'),/déjà au plafond de gaz/);
});
test('should raise legs by one 1.5× step under the gas ceiling when demand is high',()=>{
  const r=R.recommendMarket({...demand,current:{maxLegsPerRound:448,maxLiabilityBps:1000},ethCallGasCap:5_000_000});
  assert.deepEqual([r.maxLegsPerRound,r.maxLiabilityBps,r.changed],[672,1000,true]);
  assert.equal(R.recommendMarket({...demand,current:{maxLegsPerRound:896,maxLiabilityBps:1000},ethCallGasCap:50_000_000}).maxLegsPerRound,1024);
});
test('should freeze leg raises when an observed gas margin is under 30 %',()=>{
  const r=R.recommendMarket({...demand,gasFreeze:['callback VRF 1900000 gaz > 70 %'],current:{maxLegsPerRound:256,maxLiabilityBps:1000}});
  assert.equal(r.maxLegsPerRound,256);
  assert.match(r.reasons.join('\n'),/gelées/);
});
test('should lower legs back under the gas ceiling even without demand',()=>{
  const r=R.recommendMarket({...demand,legs:{p95:1},capHitRate:0,current:{maxLegsPerRound:448,maxLiabilityBps:1000},ethCallGasCap:2_000_000});
  assert.deepEqual([r.maxLegsPerRound,r.changed],[416,true]);
});
test('should change nothing when data is insufficient or the market is disabled',()=>{
  const few=R.recommendMarket({...demand,maskRounds:3,capUse:{p95:0.99},current:{maxLegsPerRound:448,maxLiabilityBps:1000}});
  assert.equal(few.changed,false);
  assert.match(few.reasons.join('\n'),/données insuffisantes/);
  const off=R.recommendMarket({...demand,current:{maxLegsPerRound:0,maxLiabilityBps:0}});
  assert.equal(off.changed,false);
  assert.match(off.reasons[0],/désactivé/);
  assert.equal(R.recommendMarket({...demand,current:null}).maxLegsPerRound,null);
});
test('should raise maxBps only when p95 liability use reaches 70 % of the cap, never above 2 500',()=>{
  const base={...demand,legs:{p95:1},capHitRate:0};
  assert.equal(R.recommendMarket({...base,capUse:{p95:0.69},current:{maxLegsPerRound:448,maxLiabilityBps:1000}}).maxLiabilityBps,1000);
  assert.equal(R.recommendMarket({...base,capUse:{p95:0.7},current:{maxLegsPerRound:448,maxLiabilityBps:1000}}).maxLiabilityBps,1500);
  assert.equal(R.recommendMarket({...base,capUse:{p95:0.9},current:{maxLegsPerRound:448,maxLiabilityBps:2000}}).maxLiabilityBps,2500);
  const top=R.recommendMarket({...base,capUse:{p95:0.9},current:{maxLegsPerRound:448,maxLiabilityBps:2500}});
  assert.equal(top.changed,false);
  assert.match(top.reasons.join('\n'),/décision du propriétaire/);
});
test('should print the activation command with --allow-above-launch-cap only above 448 legs',()=>{
  assert.equal(R.activationCommand(2,{maxLegsPerRound:448,maxLiabilityBps:1500}),'node scripts/mask-bets-v1-activate.cjs --market 2:448:1500 --print-calldata');
  assert.match(R.activationCommand(1,{maxLegsPerRound:672,maxLiabilityBps:1000}),/--market 1:672:1000 --print-calldata --allow-above-launch-cap$/);
});

test('should page eth_getLogs, halve the chunk on a range error and stop at the request bound',async()=>{
  const chain=fakeChain({rangeLimit:100_000});
  chain.bet(1,1,[straight()],250_000);
  const logs=await R.getLogsPaged(chain.send,{address:ENGINE_ADDRESS,topics:[[R.TOPIC.BetRecorded]],fromBlock:0,toBlock:399_999,chunkBlocks:400_000,maxRequests:20});
  assert.equal(logs.length,1);
  assert(chain.methods.filter(m=>m==='eth_getLogs').length<=7);
  await assert.rejects(R.getLogsPaged(chain.send,{address:ENGINE_ADDRESS,topics:[R.TOPIC.BetRecorded],fromBlock:0,toBlock:999_999,chunkBlocks:100_000,maxRequests:3}),/max-log-requests/);
  const other=fakeChain();other.send=async()=>{throw Error('connection refused');};
  await assert.rejects(R.getLogsPaged(other.send,{address:ENGINE_ADDRESS,topics:[],fromBlock:0,toBlock:10,chunkBlocks:1000,maxRequests:3}),/connection refused/);
});

test('should find the first block at or after a timestamp',async()=>{
  const chain=fakeChain({latest:5000});
  assert.equal(await R.blockAtOrAfter(chain.send,GENESIS_TIME+1234*10,5000),1234);
  assert.equal(await R.blockAtOrAfter(chain.send,GENESIS_TIME+1234*10+5,5000),1235);
  assert.equal(await R.blockAtOrAfter(chain.send,GENESIS_TIME+10**9,5000),5000);
});

test('should refuse every RPC method that is not a read',async()=>{
  const send=R.readOnly(async()=>'0x');
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','hardhat_setBalance','evm_mine','eth_estimateGas'])
    await assert.rejects(send(method,[]),/lecture seule/);
  assert.equal(await send('eth_call',[]),'0x');
});

test('should parse the window options and reject conflicting ones',()=>{
  assert.deepEqual(R.parseArgs(['--from-block','10','--to-block','20','--out','x.json']),{fromBlock:10,toBlock:20,out:'x.json'});
  assert.deepEqual(R.parseArgs(['--from','2026-11-10','--to','2026-11-17','--eth-call-gas-cap','5000000']),{from:'2026-11-10',to:'2026-11-17',ethCallGasCap:5_000_000});
  assert.throws(()=>R.parseArgs(['--days','7','--from-block','1']),/blocs OU en dates/);
  assert.throws(()=>R.parseArgs(['--days','7','--from','2026-11-10']),/s'excluent/);
  assert.throws(()=>R.parseArgs(['--to-block','9']),/demande --from-block/);
  assert.throws(()=>R.parseArgs(['--from','hier']),/date ISO/);
  assert.throws(()=>R.parseArgs(['--execute']),/Argument inconnu/);
});

/** Week of traffic: market 1 saturates its 64-leg cap, market 2 its 100 bps cap, market 3 has classic bets only. */
function trafficChain() {
  const chain=fakeChain({latest:1000,archiveFrom:600});
  chain.setLimits(1,64,1000,5);chain.setLimits(2,448,100,5);chain.setLimits(3,448,1000,5);
  chain.totalAssets.set(1,20_000n*UNIT);chain.totalAssets.set(2,6_000n*UNIT);chain.totalAssets.set(3,1_000n*UNIT);
  for(let index=0;index<25;index++) {
    const roundId=100+index,block=100+index*30;
    const legs=index<10?64:50; // 10 tours sur 25 au plafond
    chain.bet(roundId,1,[straight(),...Array.from({length:legs},()=>maskLeg())],block);
    chain.bet(roundId,2,Array.from({length:3},()=>maskLeg()),block+1);   // 54 USDC réservés sur 6 000 ⇒ 90 bps
    chain.bet(roundId,3,[straight()],block+2);
    chain.settle(roundId,1,block+10,{vrfGas:450_000+index*1000});
  }
  return chain;
}

test('should report legs, cap hits, liability, gas and recommend new limits from a week of traffic',async()=>{
  const chain=trafficChain();
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:50,toBlock:1000,ethCallGasCap:5_000_000}});
  assert.equal(report.hasData,true);
  assert(chain.methods.every(m=>['eth_chainId','hardhat_metadata','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_call','eth_getTransactionReceipt'].includes(m)));
  const [m1,m2,m3]=report.markets;
  assert.deepEqual(m1.current,{maxLegsPerRound:64,maxLiabilityBps:1000});
  assert.deepEqual([m1.legsPerRound.mean,m1.legsPerRound.p95,m1.legsPerRound.max],[55.6,64,64]);
  assert.deepEqual([m1.legCap.roundsAtCap,m1.legCap.rate],[10,0.4]);
  // 64 jambes × 18 USDC = 1 152 sur 20 000 + 65 de mises du round ⇒ 571,1 bps (archive au-delà du bloc 600).
  const archived=m1.rounds.find(r=>r.freeLiquiditySource==='archive'&&r.legs===50);
  assert.equal(archived.weightedPayout,900n*UNIT);
  assert.equal(archived.freeLiquidity,20_051n*UNIT);
  assert.equal(archived.liabilityBps,448.85);
  assert(m1.rounds.some(r=>r.freeLiquiditySource==='latest-approximation'));
  assert.match(report.warnings.join('\n'),/RPC non archive/);
  assert.deepEqual([m1.recommendation.maxLegsPerRound,m1.recommendation.maxLiabilityBps,m1.recommendation.changed],[96,1000,true]);
  assert.equal(m2.liability.bpsOfFreeLiquidity.max,89.95);
  assert.equal(m2.liability.roundsNearCap,0);
  assert.deepEqual([m2.recommendation.maxLegsPerRound,m2.recommendation.maxLiabilityBps],[448,250]);
  assert.equal(m3.activity.roundsWithBets,25);
  assert.equal(m3.activity.roundsWithMasks,0);
  assert.equal(m3.recommendation.changed,false);
  assert.deepEqual(report.commands,[
    'node scripts/mask-bets-v1-activate.cjs --market 1:96:1000 --print-calldata',
    'node scripts/mask-bets-v1-activate.cjs --market 2:448:250 --print-calldata']);
  assert.equal(report.gas.vrfCallback.withMasks.count,25);
  assert.equal(report.gas.vrfCallback.withMasks.max,474_000-50_000);
  assert.equal(report.gas.vrfCallback.budgetCallbackGasWithMasks,1_054_426);
  assert.equal(report.gas.settlement.withMasks.max,550_000);
  assert.deepEqual(report.gas.freeze,[]);
  assert.deepEqual(m1.activity.presets,{3:1390});
  assert.equal(m1.refusals.measurable,false);
  const text=R.formatReport(report);
  assert.match(text,/Marché 1 .* 64 jambes \/ 1000 bps/);
  assert.match(text,/--market 2:448:250 --print-calldata/);
  assert.doesNotMatch(JSON.stringify(report,(_k,v)=>typeof v==='bigint'?String(v):v),/https?:\/\//);
});

test('should freeze leg raises when a settlement transaction uses more than 70 % of its gas limit',async()=>{
  const chain=trafficChain();
  chain.settle(130,1,900,{settleGas:1_900_000});
  chain.bet(130,1,[maskLeg()],880);
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:50,toBlock:1000,ethCallGasCap:5_000_000}});
  assert.match(report.gas.freeze.join('\n'),/règlement 1850000 gaz > 70 %/);
  assert.equal(report.markets[0].recommendation.maxLegsPerRound,64);
  assert.match(report.markets[0].recommendation.reasons.join('\n'),/gelées/);
});

test('should use the limit in force at each round when limits change inside the window',async()=>{
  const chain=trafficChain();
  chain.setLimits(1,50,1000,399); // à partir du bloc 399, 50 jambes : les tours à 50 jambes deviennent « au plafond »
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:50,toBlock:1000}});
  const m1=report.markets[0];
  assert.deepEqual(m1.current,{maxLegsPerRound:50,maxLiabilityBps:1000});
  assert.equal(m1.rounds.find(r=>r.roundId===100).limit.maxLegsPerRound,64);
  assert.equal(m1.rounds.find(r=>r.roundId===124).limit.maxLegsPerRound,50);
  assert.equal(m1.legCap.roundsAtCap,10+15);
});

test('should report no data and recommend nothing when the engine does not serve mask bets yet',async()=>{
  const chain=fakeChain({latest:1000,supportsMasks:false});
  for(let index=0;index<5;index++){chain.bet(10+index,1,[straight()],100+index*50);chain.settle(10+index,1,120+index*50);}
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{days:1}});
  assert.equal(report.hasData,false);
  assert.equal(report.engine.supportsMasks,false);
  assert.deepEqual(report.commands,[]);
  for(const market of report.markets) {
    assert.equal(market.activity.roundsWithMasks,0);
    assert.equal(market.legsPerRound.mean,null);
    assert.equal(market.recommendation.maxLegsPerRound,null);
  }
  assert.equal(report.gas.vrfCallback.withoutMasks.count,5);
  assert.match(report.warnings.join('\n'),/Aucune jambe/);
  const text=R.formatReport(report);
  assert.match(text,/aucune donnée de paris spéciaux/);
  assert.match(text,/Aucune commande : réglages inchangés/);
});

test('should keep limits unchanged when masks are enabled but nobody played them',async()=>{
  const chain=fakeChain({latest:1000});
  chain.setLimits(1,448,1000,5);
  chain.bet(10,1,[straight()],100);
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:1,toBlock:1000}});
  assert.equal(report.hasData,false);
  assert.deepEqual(report.markets[0].current,{maxLegsPerRound:448,maxLiabilityBps:1000});
  assert.equal(report.markets[0].recommendation.changed,false);
  assert.match(report.markets[0].recommendation.reasons.join('\n'),/données insuffisantes/);
  assert.deepEqual(report.commands,[]);
});

test('should block every raise and say why when no gas observation covers the mask rounds',async()=>{
  const chain=trafficChain();
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:50,toBlock:1000,ethCallGasCap:5_000_000,maxReceipts:0}});
  assert.equal(report.gas.vrfCallback.withMasks.count,0);
  assert.match(report.gas.missing.join('\n'),/aucune observation de gaz du callback VRF/);
  assert.match(report.gas.missing.join('\n'),/aucune observation de gaz du règlement/);
  const [m1,m2]=report.markets;
  assert.deepEqual([m1.recommendation.maxLegsPerRound,m1.recommendation.changed],[64,false]);
  assert.deepEqual([m2.recommendation.maxLiabilityBps,m2.recommendation.changed],[100,false]);
  assert.match(m1.recommendation.reasons.join('\n'),/hausse bloquée : aucune observation de gaz/);
  assert.deepEqual(report.commands,[]);
  assert.match(R.formatReport(report),/Hausses BLOQUÉES/);
});

test('should show but never count rounds that the window cuts at either end',async()=>{
  const chain=trafficChain();
  // Tour 200 : 50 jambes au bloc 900, puis 14 au bloc 950, réglé au bloc 960 ; la fenêtre s'arrête au bloc 920.
  chain.bet(200,1,Array.from({length:50},()=>maskLeg()),900);
  chain.bet(200,1,Array.from({length:14},()=>maskLeg()),950);
  chain.settle(200,1,960);
  // La fenêtre commence au bloc 101 : le tour 100 (compte à rebours au bloc 100) est coupé au début.
  const report=await R.buildReport({send:chain.send,d:DEPLOYMENT,budget:BUDGET,options:{fromBlock:101,toBlock:920,ethCallGasCap:5_000_000}});
  const [m1,m2]=report.markets;
  assert.equal(m1.activity.roundsWithMasks,24);           // tours 101..124 (100 coupé au début, 200 à la fin)
  assert.equal(m2.activity.roundsWithMasks,24);
  assert.equal(m1.legsPerRound.max,64);
  assert.equal(m1.legCap.roundsAtCap,9);                 // tours 101..109
  const cutEnd=m1.rounds.find(r=>r.roundId===200),cutStart=m2.rounds.find(r=>r.roundId===100);
  assert.equal(cutEnd.incomplete,true);
  assert.equal(cutEnd.legs,50);                           // compteurs de la fenêtre, pas ceux du tour entier
  assert.equal(cutEnd.atLegCap,false);
  assert.equal(cutStart.incomplete,true);
  assert.equal(m1.activity.incompleteRounds,1);
  assert.match(report.warnings.join('\n'),/incomplet/);
  assert(m1.rounds.filter(r=>!r.incomplete).every(r=>r.roundId>=101&&r.roundId<=124));
});
