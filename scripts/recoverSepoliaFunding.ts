import {network,viem} from 'hardhat';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {vars} from 'hardhat/config';
import {privateKeyToAccount} from 'viem/accounts';
import {encodeAbiParameters,parseAbi} from 'viem';
import {verifyContractWithDelay} from './utils/verifyWithEtherscan';
const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
async function main(){
 const live=network.name==='arbitrumsepolia';
 if(!live&&network.name!=='hardhat')throw Error('Sepolia or local fork only');
 if(live&&process.env.CONFIRM_SEPOLIA_FUNDER!=='421614:queueFunding')throw Error('Explicit testnet confirmation required');
 if(!live)await network.provider.request({method:'hardhat_reset',params:[{forking:{jsonRpcUrl:'https://sepolia-rollup.arbitrum.io/rpc',blockNumber:Number(JSON.parse(readFileSync('reports/diagnostics/sepolia-round-before.json','utf8')).block)}}]});
 const pc=await viem.getPublicClient();if(await pc.getChainId()!==(live?421614:31337))throw Error('Wrong chain');
 const key=vars.get('BRB_KEY');const admin=privateKeyToAccount((key.startsWith('0x')?key:`0x${key}`) as `0x${string}`).address;
 if(!live){await network.provider.request({method:'hardhat_impersonateAccount',params:[admin]});await network.provider.request({method:'hardhat_setBalance',params:[admin,'0x56bc75e2d63100000']})}
 const [wallet]=await viem.getWalletClients();
 const engine=await viem.getContractAt('RouletteEngine','0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1');
 const oldAddress=await engine.read.JACKPOT_FUNDER();
 if(oldAddress.toLowerCase()!=='0xfb5075174cb85adfbf0a4e946840cbfd03bf48a2')throw Error('Unexpected active funder');
 if(!await engine.read.hasRole([await engine.read.ENGINE_FEE_ROLE(),admin]))throw Error('Missing fee role');
 const old=await viem.getContractAt('BRBJackpotFunder',oldAddress);
 const pendingTreasury=await old.read.pendingTreasuryBrb();const pendingBurn=await old.read.pendingBurnBrb();
 if(pendingTreasury!==0n||pendingBurn!==0n)throw Error('Old funder has liabilities; reconcile before migration');
 const args=[engine.address,await old.read.brbToken(),await old.read.router(),await engine.read.JACKPOT_TREASURY(),await old.read.sideBet(),admin] as const;
 const policy={swap:await old.read.swapAssetTotalBps(),numerator:await old.read.treasuryBrbNumerator(),denominator:await old.read.treasuryBrbDenominator(),slippage:await old.read.slippageBps(),cold:await old.read.coldSlippageBps(),twap:await old.read.twapWindowSeconds()};
 const registry=await viem.getContractAt('MarketRegistry',await engine.read.REGISTRY());const oldBalances=[];
 for(let id=1;id<=Number(await registry.read.marketCount());id++){const m=await registry.read.getMarket([id]);oldBalances.push({marketId:id,asset:m.asset,balance:await pc.readContract({address:m.asset,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[oldAddress]})})}
 const path=`reports/diagnostics/sepolia-funder-${live?'live':'rehearsal'}.json`;if(live&&existsSync(path))throw Error('Live journal already exists; inspect receipts');
 if(live){const rehearsal=JSON.parse(readFileSync('reports/diagnostics/sepolia-funder-rehearsal.json','utf8'));if(!rehearsal.settlementPassed||json(policy)!==json(rehearsal.policy)||json(args).toLowerCase()!==json(rehearsal.constructorArgs).toLowerCase())throw Error('Rehearsal mismatch')}
 const report:Record<string,any>={chainId:live?421614:31337,oldFunder:oldAddress,constructorArgs:args,policy,oldBalances,pendingTreasury,pendingBurn,status:'deploying',startBlock:(await pc.getBlockNumber()).toString()};
 const save=()=>{mkdirSync('reports/diagnostics',{recursive:true});writeFileSync(path,json(report)+'\n')};save();
 const funder=await viem.deployContract('BRBJackpotFunder',args,{account:live?wallet.account:admin});report.newFunder=funder.address;report.status='deployed';save();
 const wait=async(hash:`0x${string}`)=>{const r=await pc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error('Transaction reverted');return r};
 if(policy.swap!==300n)await wait(await funder.write.setSwapAssetBps([policy.swap],{account:admin}));
 if(policy.numerator!==250n||policy.denominator!==300n)await wait(await funder.write.setTreasuryBrbSplit([policy.numerator,policy.denominator],{account:admin}));
 if(policy.slippage!==100n)await wait(await funder.write.setSlippageBps([policy.slippage],{account:admin}));
 if(policy.cold!==300n)await wait(await funder.write.setColdSlippageBps([policy.cold],{account:admin}));
 if(policy.twap!==BigInt(await funder.read.twapWindowSeconds()))await wait(await funder.write.setTwapWindowSeconds([policy.twap],{account:admin}));
 report.wiringTx=await engine.write.setJackpotFunder([funder.address],{account:admin});save();await wait(report.wiringTx);
 const scheduler=await viem.getContractAt('UpkeepScheduler',await engine.read.UPKEEP_SCHEDULER());const round=await engine.read.currentGlobalRound();report.round=round.toString();report.settlementTxs=[];
 for(let iteration=0;iteration<10;iteration++){
  let progressed=false;
  for(let lane=0;lane<Number(await engine.read.payoutParallelLaneCount());lane++){
   const [needed,data]=await scheduler.read.checkUpkeep([lane===0?'0x':encodeAbiParameters([{type:'uint256'}],[BigInt(lane)])]);if(!needed)continue;
   const jobKind=Number(BigInt(`0x${data.slice(130,194)}`));if(jobKind!==2)throw Error('Refusing non-payout job');
   await pc.simulateContract({address:scheduler.address,abi:scheduler.abi,functionName:'performUpkeep',args:[data],account:admin,gas:2500000n});
   const hash=await scheduler.write.performUpkeep([data],{account:admin,gas:2500000n});report.settlementTxs.push(hash);save();await wait(hash);progressed=true;
  }
  if(await engine.read.currentGlobalRound()>round)break;
  if(!progressed)throw Error('No payout progress');
 }
 const diag=await engine.read.roundDiagnostics([round]);
 if(await engine.read.currentGlobalRound()<=round||diag.marketsParticipating!==diag.marketsSettled)throw Error('Settlement did not complete');
 report.settlementPassed=true;report.nextRound=(await engine.read.currentGlobalRound()).toString();report.queued=await funder.read.fundingAccounts([3]);report.status='settled';save();
 // Native BRB queue only; no AMM execution, and never alter old-funder balances.
 if(report.queued[1]>0n){report.fundingTx=await funder.write.processFunding([3],{account:admin,gas:1000000n});save();await wait(report.fundingTx)}
 report.remainingQueued=await funder.read.fundingAccounts([3]);if(report.remainingQueued[1]!==0n)throw Error('BRB queue did not drain');report.status='recovered';save();
 if(live){await verifyContractWithDelay(funder.address,[...args],0,'contracts/BRBJackpotFunder.sol:BRBJackpotFunder');report.status='verified';save()}
 console.log(json({newFunder:report.newFunder,round:report.round,nextRound:report.nextRound,status:report.status,oldBalancesPreserved:true}));
}
main().catch((e:any)=>{console.error(String(e.shortMessage||e.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[RPC redacted]'));process.exitCode=1});
