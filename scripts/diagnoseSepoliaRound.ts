import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { viem } from "hardhat";
import { encodeAbiParameters, decodeAbiParameters, parseAbiParameters } from "viem";
import { mkdirSync, writeFileSync } from "node:fs";
async function main() {
 const pc=await viem.getPublicClient(); if(await pc.getChainId()!==421614) throw Error("Wrong chain");
 const engine=await viem.getContractAt("RouletteEngine","0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1");
 const scheduler=await viem.getContractAt("UpkeepScheduler",await engine.read.UPKEEP_SCHEDULER());
 const round=await engine.read.currentGlobalRound(); const lanes=[];
 for(let i=0;i<Number(await engine.read.payoutParallelLaneCount());i++) {
  const [needed,data]=await scheduler.read.checkUpkeep([i===0?'0x':encodeAbiParameters([{type:'uint256'}],[BigInt(i)])]);
  let decoded:unknown;
  if(needed) decoded=decodeAbiParameters(parseAbiParameters('uint8,uint256,(uint8 kind,uint32 marketId,uint64 roundId,uint32 nextCursor,uint32 payoutShardIndex,uint32 payoutShardWidth),(address player,uint256 amount)[],address[],uint256[]'),data);
  lanes.push({lane:i,needed,decoded});
 }
 const secrets=parse(readFileSync('../cre-automation-starter/.dev.vars'));
 const raw=secrets.KEEPER_PRIVATE_KEY; const keeper=privateKeyToAccount((raw.startsWith('0x')?raw:`0x${raw}`) as `0x${string}`).address;
 const auth=await viem.getContractAt('CreExecutionAuthority',await scheduler.read.forwarderAuthority());
 const [needed,performData]=await scheduler.read.checkUpkeep(['0x']);
 const simulation:Record<string,unknown>={keeper,approved:await auth.read.isApprovedAutomationForwarder([keeper]),balance:await pc.getBalance({address:keeper})};
 if(needed) try {await pc.simulateContract({address:scheduler.address,abi:scheduler.abi,functionName:'performUpkeep',args:[performData],account:keeper});simulation.success=true} catch(e:any){simulation.success=false; simulation.error=e.shortMessage; simulation.cause=e.cause?.data||e.cause?.cause?.data||e.cause?.shortMessage; const causes=[];for(let c=e;c;c=c.cause){causes.push({name:c.name,data:c.data,details:c.details?.replace(/https?:\/\/\S+/g,"[RPC redacted]")})};simulation.causes=causes;}
 const registry=await viem.getContractAt("MarketRegistry",await engine.read.REGISTRY()); const markets=[];
 for(let i=1;i<=Number(await registry.read.marketCount());i++) markets.push({id:i,roundState:await engine.read.marketRoundStateByRound([round,i]),cursor0:await engine.read.payoutShardCursor([round,i,0]),cursor1:await engine.read.payoutShardCursor([round,i,1])});
 const funder=await viem.getContractAt('BRBJackpotFunder',await engine.read.JACKPOT_FUNDER());const funderChecks:Record<string,unknown>={address:funder.address};for(const fn of ['engine','sideBet','swapAssetTotalBps','pendingTreasuryBrb','pendingBurnBrb'] as const)try{funderChecks[fn]=await funder.read[fn]()}catch{funderChecks[fn]='read failed'};
 const report={funderChecks,chainId:421614,block:await pc.getBlockNumber(),round,phase:await engine.read.roundPhase([round]),pendingVrf:await engine.read.hasPendingVrf(),diagnostics:await engine.read.roundDiagnostics([round]),scheduler:scheduler.address,authority:await scheduler.read.forwarderAuthority(),simulation,lanes,markets};
 const out=JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2); mkdirSync('reports/diagnostics',{recursive:true});writeFileSync('reports/diagnostics/sepolia-round.json',out+'\n');console.log(out);
}
main().catch(e=>{console.error(String(e.shortMessage||e.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[RPC redacted]'));process.exitCode=1});
