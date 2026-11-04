// The same production transaction sequence is used by the fork and mainnet entry points.
// No impersonation, snapshots, injected storage, test deposits or flag-unpause transactions here.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Contract,ContractFactory,ZeroHash,getCreateAddress,keccak256,id}=require('ethers');
const manifest=require('../reports/incident-2026-11-04/before-recovery-deployment.json');
const A=manifest.addresses,ADMIN=manifest.protocolAdmin;
const BANK='0x5F9332b04b2590850c7681850cA445dDF7f64aa9';
const HOLDER='0x2f2B6a18a43f94c4b4a0Ca03215B45Cf15ca17C1';
const ORIGINAL_SUPPLY=274523634831654689002891394529n;
const IMPLEMENTATION_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ROOT=path.resolve(__dirname,'..'),DIR=path.join(ROOT,'reports/incident-2026-11-04');
const stringify=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const addressEqual=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
const artifact=name=>JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts/contracts',name+'.sol',name+'.json')));

async function assertExecutionNetwork(provider,mode) {
  assert(['fork','mainnet'].includes(mode),'Select fork or mainnet explicitly');
  const expected=mode==='fork'?31337:42161;
  assert.equal(Number(BigInt(await provider.send('eth_chainId',[]))),expected,'Unexpected execution chain; no transaction sent');
  if(mode==='fork') {
    const metadata=await provider.send('hardhat_metadata',[]);
    assert.equal(metadata.chainId,31337,'Local fork metadata must identify chain 31337');
    assert.equal(metadata.forkedNetwork?.chainId,42161,'Expected an Arbitrum mainnet fork');
  } else {
    assert.equal(process.env.INCIDENT_MAINNET_CONFIRM,'arbitrum-one:42161','Mainnet execution requires explicit confirmation');
    let metadata;
    try {metadata=await provider.send('hardhat_metadata',[]);} catch {}
    assert(!metadata,'Mainnet execution cannot use a Hardhat node');
  }
  return expected;
}

async function executeRecovery({provider,signer,mode,reportPath,sourceBlock}) {
  const chainId=await assertExecutionNetwork(provider,mode);
  addressEqual(await signer.getAddress(),ADMIN);
  assert.equal(signer.provider,provider,'Signer must use the checked execution provider');
  const current=JSON.parse(fs.readFileSync(path.join(DIR,'recovery-artifacts.json')));
  const clean=JSON.parse(fs.readFileSync(path.join(DIR,'future-upgrade-artifacts.json')));
  for(const [revision,group] of Object.entries({recovery:current,clean}))for(const [name,a] of Object.entries(group)) {
    assert((a.deployedBytecode.length-2)/2<=24576,name+' '+revision+' runtime exceeds EIP-170');
    assert((a.bytecode.length-2)/2<=49152,name+' '+revision+' initcode exceeds EIP-3860');
    const recoveryName=name==='SideBet'?'recoverNovember2026Tickets':'recoverNovember2026';
    assert.equal(a.abi.some(row=>row.type==='function'&&row.name===recoveryName),revision==='recovery');
  }
  const bank=new Contract(BANK,current.BankVault4626.abi,provider);
  const side=new Contract(A.sideBet,current.SideBet.abi,provider);
  const brb=new Contract(A.brb,artifact('BRBToken').abi,provider);
  const beacon=new Contract(A.vaultBeacon,['function implementation() view returns(address)','function owner() view returns(address)','function upgradeTo(address)'],provider);
  const authority=new Contract(A.creExecutionAuthority,artifact('CreExecutionAuthority').abi,provider);
  const engine=new Contract(A.engine||A.rouletteEngine,artifact('RouletteEngine').abi,provider);
  const role=await side.SETTLEMENT_ROLE();
  const protectedAccounts=[ADMIN,manifest.infraRecipient,manifest.marketingWallet,manifest.houseBotWallet].filter(Boolean);

  async function snapshot() {
    const count=Number(await side.betCount());
    assert(count<=1000,'Unexpected ticket count; review state before execution');
    const tickets=[];
    for(let i=0;i<count;i++)tickets.push((await side.getBet(i)).toArray().map(String));
    const otherBanks=[];
    for(const address of A.banks.filter(a=>a.toLowerCase()!==BANK.toLowerCase())) {
      const v=new Contract(address,current.BankVault4626.abi,provider);
      otherBanks.push({address,supply:String(await v.totalSupply()),assets:String(await v.totalAssets()),locked:String(await v.lockedBetLiquidity())});
    }
    return {shares:String(await bank.balanceOf(HOLDER)),supply:String(await bank.totalSupply()),
      locked:String(await bank.lockedBetLiquidity()),reserved:String(await side.reservedOf(1)),
      bankBRB:String(await brb.balanceOf(BANK)),holderBRB:String(await brb.balanceOf(HOLDER)),brbSupply:String(await brb.totalSupply()),
      configCount:String(await side.configCount()),tickets,otherBanks,
      protectedShares:await Promise.all(protectedAccounts.map(async a=>({address:a,shares:String(await bank.balanceOf(a))}))),
      keeperApproved:await authority.isApprovedAutomationForwarder(manifest.automation.keeper),
      schedulerSettlement:await side.hasRole(role,A.scheduler),
      bankImplementation:await beacon.implementation(),sideImplementation:'0x'+(await provider.getStorage(A.sideBet,IMPLEMENTATION_SLOT)).slice(-40)};
  }
  async function assertIncidentState(reference) {
    assert.equal(await engine.hasPendingVrf(),false,'Pending VRF; stop before recovery');
    assert.equal(await engine.isBankLiquidityRestricted(1),false,'Market is resolving; stop before recovery');
    const state=await snapshot();
    const active=state.tickets.map((t,i)=>({t,i})).filter(({t})=>t[11]==='0');
    assert.deepEqual(active.map(({i})=>i),[9,10,11,12,13],'Active tickets changed; stop');
    for(const {t} of active){addressEqual(t[0],HOLDER);assert.equal(t[1],'1');}
    const reserves=active.reduce((sum,{t})=>sum+BigInt(t[3]),0n);
    assert.equal(BigInt(state.locked),reserves,'Unexpected bank lock');
    assert.equal(BigInt(state.reserved),reserves,'Unexpected side-bet reserve');
    assert.equal(BigInt(state.supply)-BigInt(state.shares),ORIGINAL_SUPPLY,'Other share balances changed; stop');
    assert(BigInt(state.shares)>0n,'Incident shares already recovered; do not rerun');
    if(reference)for(const key of ['shares','supply','locked','reserved','bankBRB','holderBRB','brbSupply','configCount','tickets','otherBanks','protectedShares','keeperApproved','schedulerSettlement']) {
      assert.deepEqual(state[key],reference[key],key+' changed during execution; stop');
    }
    return state;
  }
  assert.equal(await bank.hasRole(ZeroHash,ADMIN),true,'Bank admin role missing');
  assert.equal(await side.hasRole(ZeroHash,ADMIN),true,'SideBet admin role missing');
  addressEqual(await beacon.owner(),ADMIN);
  const before=await assertIncidentState();
  addressEqual(before.bankImplementation,A.bankVaultImplementation);
  addressEqual(before.sideImplementation,A.sideBetImplementation);
  const legacy=require('../test/fixtures/BankVault4626.pre-2026-11-04.json');
  assert.equal(keccak256(await provider.getCode(before.bankImplementation)),keccak256(legacy.deployedBytecode),'Unexpected deployed bank bytecode');
  const latestNonce=Number(BigInt(await provider.send('eth_getTransactionCount',[ADMIN,'latest'])));
  assert.equal(Number(BigInt(await provider.send('eth_getTransactionCount',[ADMIN,'pending']))),latestNonce,'Administrator has pending transactions');
  const report={status:'running',mode,executionChainId:chainId,sourceChainId:42161,sourceBlock,
    admin:ADMIN,initialAdminNonce:latestNonce,mainnetTransactionsSent:false,before,transactions:[],implementations:{},
    artifactHashes:Object.fromEntries(Object.entries({recoveryBank:current.BankVault4626,recoverySide:current.SideBet,cleanBank:clean.BankVault4626,cleanSide:clean.SideBet}).map(([key,a])=>[key,keccak256(a.bytecode)]))};
  const persist=()=>{fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,stringify(report));};
  persist();
  async function send(label,request) {
    await assertExecutionNetwork(provider,mode);
    const nonce=latestNonce+report.transactions.length;
    assert.equal(Number(BigInt(await provider.send('eth_getTransactionCount',[ADMIN,'pending']))),nonce,'Administrator nonce changed; stop');
    const txRequest={...await request,chainId,nonce,value:0n};
    // Estimate against the same provider which will receive this transaction.
    txRequest.gasLimit=(await signer.estimateGas(txRequest))*125n/100n;
    await assertExecutionNetwork(provider,mode);
    const tx=await signer.sendTransaction(txRequest);
    const entry={label,hash:tx.hash,chainId:Number(tx.chainId),nonce:tx.nonce,to:tx.to,dataHash:keccak256(tx.data),status:'submitted'};
    report.transactions.push(entry);report.mainnetTransactionsSent=mode==='mainnet';persist();
    assert.equal(entry.chainId,chainId);assert.equal(tx.nonce,nonce);addressEqual(tx.from,ADMIN);
    const receipt=await tx.wait();entry.status=receipt.status===1?'confirmed':'reverted';
    entry.blockNumber=receipt.blockNumber;entry.gasUsed=String(receipt.gasUsed);persist();
    assert.equal(receipt.status,1,label+' reverted');console.log(label+' — chain '+chainId);
    return receipt;
  }
  async function deploy(label,key,a) {
    const nonce=latestNonce+report.transactions.length;
    const address=getCreateAddress({from:ADMIN,nonce});
    await send(label,new ContractFactory(a.abi,a.bytecode).getDeployTransaction());
    const code=await provider.getCode(address);assert.notEqual(code,'0x','Implementation deployment missing');
    assert.equal((code.length-2)/2,(a.deployedBytecode.length-2)/2,'Unexpected implementation runtime size');
    report.implementations[key]={address,runtimeHash:keccak256(code)};persist();return address;
  }
  try {
    // Deploy all four implementations before installing the temporary recovery functions.
    const recoveryBank=await deploy('Deploy recovery bank','recoveryBank',current.BankVault4626);
    const recoverySide=await deploy('Deploy recovery SideBet','recoverySide',current.SideBet);
    const cleanBank=await deploy('Deploy bank without recovery','cleanBank',clean.BankVault4626);
    const cleanSide=await deploy('Deploy SideBet without recovery','cleanSide',clean.SideBet);
    await assertIncidentState(before);
    await send('Upgrade SideBet and set sideBetsDisabled true',side.upgradeToAndCall.populateTransaction(recoverySide,side.interface.encodeFunctionData('setSideBetsDisabled',[true])));
    assert.equal(await side.sideBetsDisabled(),true);
    await assertIncidentState(before);
    await send('Upgrade bank beacon to recovery implementation',beacon.upgradeTo.populateTransaction(recoveryBank));
    await assertIncidentState(before);
    const receipt=await send('Burn incident shares and cancel five tickets atomically',bank.recoverNovember2026.populateTransaction());
    assert.equal(receipt.logs.some(l=>l.address.toLowerCase()===A.brb.toLowerCase()),false,'Recovery changed BRB balances');
    const burns=receipt.logs.filter(l=>l.address.toLowerCase()===BANK.toLowerCase()&&l.topics[0]===id('Transfer(address,address,uint256)'));
    assert.equal(burns.length,1);
    const events=receipt.logs.map(l=>{if(l.address.toLowerCase()!==A.sideBet.toLowerCase())return null;try{return side.interface.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='SideBetSettled');
    assert.equal(events.length,5);for(const event of events)assert.equal(event.args.payout,0n);
    const recovered=await snapshot();
    assert.equal(recovered.shares,'0');assert.equal(recovered.supply,String(ORIGINAL_SUPPLY));
    assert.equal(recovered.locked,'0');assert.equal(recovered.reserved,'0');
    for(const key of ['bankBRB','holderBRB','brbSupply','configCount','protectedShares','otherBanks'])assert.deepEqual(recovered[key],before[key],key+' changed during recovery');
    for(let i=0;i<9;i++)assert.deepEqual(recovered.tickets[i],before.tickets[i]);
    for(let i=9;i<=13;i++)assert.equal(recovered.tickets[i][11],'4');
    await send('Remove bank recovery through beacon upgrade',beacon.upgradeTo.populateTransaction(cleanBank));
    await send('Remove SideBet recovery through UUPS upgrade',side.upgradeToAndCall.populateTransaction(cleanSide,'0x'));
    assert.equal(await side.sideBetsDisabled(),true);
    await assert.rejects(bank.recoverNovember2026.staticCall(),'Bank recovery selector still callable');
    await assert.rejects(side.recoverNovember2026Tickets.staticCall(),'SideBet recovery selector still callable');
    assert.equal(await side.hasRole(ZeroHash,ADMIN),true);assert.equal(await bank.hasRole(ZeroHash,ADMIN),true);
    addressEqual(await beacon.owner(),ADMIN);
    const after=await snapshot();
    for(const key of Object.keys(recovered).filter(k=>!['bankImplementation','sideImplementation'].includes(k)))assert.deepEqual(after[key],recovered[key],key+' changed during cleanup');
    addressEqual(after.bankImplementation,cleanBank);addressEqual(after.sideImplementation,cleanSide);
    assert.equal(after.keeperApproved,before.keeperApproved,'Keeper authority changed');
    assert.equal(after.schedulerSettlement,before.schedulerSettlement,'Scheduler settlement role changed');
    report.after={...after,sideBetsDisabled:true};report.recoveryFunctionsRemoved=true;
    report.status='passed';persist();return report;
  } catch(error) {
    report.status='failed';report.error=String(error.shortMessage||error.message).replace(/https?:\/\/\S+/g,'[RPC]').slice(0,1200);
    persist();throw error;
  }
}
module.exports={executeRecovery,assertExecutionNetwork,ADMIN};
