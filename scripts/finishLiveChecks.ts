import { ethers } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
async function main() {
  if ((await ethers.provider.getNetwork()).chainId!==421614n) throw new Error('Wrong network');
  const rollout=JSON.parse(readFileSync('deployments/rollout-2026-10-09-live.json','utf8'));
  const catalog=JSON.parse(readFileSync('../subgraph/deployments/arbitrum-sepolia.json','utf8'));
  const a=catalog.addresses;
  const engine:any=await ethers.getContractAt('RouletteEngine',a.roulette);
  const side:any=await ethers.getContractAt('SideBet',a.sideBet);
  const receiver:any=await ethers.getContractAt('AutomationReceiver',a.automationReceiver);
  let cost=0n;
  for (const tx of rollout.transactions) {
    const receipt=await ethers.provider.getTransactionReceipt(tx.hash);
    if (!receipt || receipt.status!==1) throw new Error(`Unconfirmed transaction ${tx.hash}`);
    cost+=receipt.fee;
  }
  const [balance,native,requests,owner,consumers]=await new ethers.Contract(catalog.vrf.coordinator,['function getSubscription(uint256) view returns(uint96,uint96,uint64,address,address[])'],ethers.provider).getSubscription(catalog.vrf.subscriptionId);
  if (!consumers.map((v:string)=>v.toLowerCase()).includes(a.roulette.toLowerCase())) throw new Error('VRF consumer absent');
  const signature=ethers.id('performUpkeep(bytes)').slice(0,10);
  const receiverConfig={address:a.automationReceiver,owner:await receiver.owner(),forwarder:await receiver.getForwarderAddress(),expectedAuthor:await receiver.getExpectedAuthor(),expectedWorkflowId:await receiver.getExpectedWorkflowId(),schedulerAllowed:await receiver.isCallAllowed(a.scheduler,signature)};
  if (receiverConfig.forwarder===ethers.ZeroAddress || !receiverConfig.schedulerAllowed) throw new Error('Invalid receiver wiring');
  const fromBlock=rollout.transactions.find((tx:any)=>tx.label==='upgrade engine').blockNumber;
  const logs=await ethers.provider.getLogs({address:[a.roulette,a.jackpotFunder],fromBlock,topics:[[ethers.id('VrfRequested(uint64,uint256,uint256)'),ethers.id('VRFResult(uint64,uint8,uint8)'),ethers.id('RoundResolved(uint64)'),ethers.id('FundingAttemptCompleted(uint256,uint256,uint256)')]]});
  const postUpgradeActivity=logs.map(log=>{
    const abi=log.address.toLowerCase()===a.roulette.toLowerCase()?engine.interface:new ethers.Interface(['event FundingAttemptCompleted(uint256 indexed attemptId,uint256 remainingInput,uint256 remainingBrb)']);
    const parsed=abi.parseLog(log);
    return {event:parsed?.name,id:String(parsed?.args[0]),transactionHash:log.transactionHash,blockNumber:log.blockNumber};
  });
  const result={chainId:421614, block:await ethers.provider.getBlockNumber(), transactionsConfirmed:rollout.transactions.length, transactionFeesETH:ethers.formatEther(cost),postUpgradeActivity,
    signerBalanceETH:ethers.formatEther(await ethers.provider.getBalance(rollout.signer)),
    engineProxy:a.roulette,sideBetProxy:a.sideBet,currentRound:String(await engine.currentGlobalRound()),pendingVrf:await engine.hasPendingVrf(),
    configCount:String(await side.configCount()),betCount:String(await side.betCount()),settleTimeout:String(await side.settleTimeout()),
    vrf:{link:ethers.formatEther(balance),nativeBalance:String(native),requestCount:String(requests),owner,engineRegistered:true},receiverConfig,
    pending:['Treasury migration requires a reviewed mechanism to preserve the existing jackpot pool; current treasury retained','Receiver migration requires updating live CRE workflow receiver targets; current receiver retained','TipJar indexer and frontend activation pending; generated local indexer manifest is not deployed','X100 catalogue remains unseeded; dry run needs USDC liquidity and verified compatible frontend before activation']};
  writeFileSync('deployments/final-checks-2026-10-09.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
