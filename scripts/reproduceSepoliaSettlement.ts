import {network,viem} from 'hardhat';
import {encodeFunctionData,encodeAbiParameters,parseAbiParameters} from 'viem';
import {readFileSync,writeFileSync} from 'node:fs';
async function main(){
 if(network.name!=='hardhat')throw Error('Local fork only');
 await network.provider.request({method:'hardhat_reset',params:[{forking:{jsonRpcUrl:'https://sepolia-rollup.arbitrum.io/rpc',blockNumber:Number(JSON.parse(readFileSync('reports/diagnostics/sepolia-round-before.json','utf8')).block)}}]});
 console.log('Fork reset completed'); const pc=await viem.getPublicClient();if(await pc.getChainId()!==31337)throw Error('Wrong local chain');
 const scheduler=await viem.getContractAt('UpkeepScheduler','0x098A5a03Be176aAe3413ad98f57CB4c63E16B49D');
 const before=JSON.parse(readFileSync('reports/diagnostics/sepolia-round-before.json','utf8'));
 const decoded=before.lanes.find((lane:any)=>lane.needed).decoded;
 decoded[1]=BigInt(decoded[1]);decoded[2].roundId=BigInt(decoded[2].roundId);
 const needed=true;const data=encodeAbiParameters(parseAbiParameters('uint8,uint256,(uint8 kind,uint32 marketId,uint64 roundId,uint32 nextCursor,uint32 payoutShardIndex,uint32 payoutShardWidth),(address player,uint256 amount)[],address[],uint256[]'),decoded);
 if(!needed)throw Error('No work');
 console.log('Pending job read'); const call={from:'0xbbbbeDc42dC53842141Be8F70Df9EFe4d08538A4',to:scheduler.address,data:encodeFunctionData({abi:scheduler.abi,functionName:'performUpkeep',args:[data]}),gas:'0x989680'};
 try{await network.provider.request({method:'eth_call',params:[call,'latest']});console.log('Call succeeded')}catch(e:any){console.log(String(e.message).split('\n').slice(0,8).join('\n'));console.log('Revert data:',JSON.stringify(e.data))}
 const trace:any=await network.provider.request({method:'debug_traceCall',params:[call,'latest',{disableMemory:true,disableStorage:true}]});
 const events=trace.structLogs.filter((l:any)=>['CALL','DELEGATECALL','STATICCALL','REVERT','INVALID'].includes(l.op)).map((l:any)=>({op:l.op,depth:l.depth,pc:l.pc,gas:l.gas,stack:l.stack?.slice(-7)}));
 writeFileSync('reports/diagnostics/sepolia-settlement-trace.json',JSON.stringify({failed:trace.failed,gas:trace.gas,returnValue:trace.returnValue,events},null,2)+'\n');
 console.log(JSON.stringify({failed:trace.failed,gas:trace.gas,returnValue:trace.returnValue,events:events.slice(-20)},null,2));
}
main().catch((e:any)=>{for(let c=e;c;c=c.cause)console.error(String(c.message||c.details||c).replace(/https?:\/\/\S+/g,'[RPC redacted]').slice(0,2200)); console.error('Local settlement reproduction failed; transport details withheld');process.exitCode=1});
