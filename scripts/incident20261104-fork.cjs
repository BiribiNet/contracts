// Local fork setup only. Never imported or invoked by the mainnet execution branch.
const path=require('node:path');
const assert=require('node:assert/strict');
const {executeRecovery,ADMIN}=require('./incident20261104-execution.cjs');

async function main() {
  require('ts-node/register');const hre=require('hardhat');
  const {JsonRpcProvider}=require('ethers');
  assert.equal(hre.network.name,'hardhat');assert.equal(hre.network.config.chainId,31337);
  assert.equal(hre.network.config.url,undefined);assert.equal(hre.network.config.allowUnlimitedContractSize,false);
  assert.deepEqual(Object.keys(hre.config.networks).sort(),['hardhat','localhost']);
  const rpc=process.env.INCIDENT_FORK_URL;
  const url=new URL(rpc);assert.equal(url.hostname,'127.0.0.1','Fork source must use the local read-only relay');
  class ReadOnlySource extends JsonRpcProvider {
    send(method,params) {
      assert(!/send|sign|personal|hardhat|anvil|evm_/i.test(method),'Source provider is read-only');
      return super.send(method,params);
    }
  }
  const source=new ReadOnlySource(rpc,42161,{staticNetwork:true});
  try {
    assert.equal(Number(BigInt(await source.send('eth_chainId',[]))),42161);
    const block=process.env.INCIDENT_FORK_BLOCK?Number(process.env.INCIDENT_FORK_BLOCK):await source.getBlockNumber();
    assert(Number.isSafeInteger(block)&&block>0,'Invalid fork block');
    console.log('Preparing local chain 31337 from Arbitrum block '+block+'. Upstream RPC is read-only.');
    await hre.network.provider.request({method:'hardhat_reset',params:[{forking:{jsonRpcUrl:rpc,blockNumber:block}}]});
    await hre.network.provider.request({method:'hardhat_impersonateAccount',params:[ADMIN]});
    await hre.network.provider.request({method:'hardhat_setBalance',params:[ADMIN,'0x56bc75e2d63100000']});
    const provider=hre.ethers.provider,signer=await hre.ethers.getSigner(ADMIN);
    const report=await executeRecovery({provider,signer,mode:'fork',sourceBlock:block,
      reportPath:path.resolve(__dirname,'../reports/incident-2026-11-04/mainnet-script-fork-rehearsal.json')});
    console.log(JSON.stringify({status:report.status,executionChainId:31337,sourceBlock:block,
      productionTransactions:report.transactions.length,mainnetTransactionsSent:false,
      recoveryFunctionsRemoved:report.recoveryFunctionsRemoved,sideBetsDisabled:report.after.sideBetsDisabled},null,2));
  } finally {await source.destroy();}
}
if(require.main===module)main().catch(error=>{
  console.error(String(error.shortMessage||error.message).replace(/https?:\/\/\S+/g,'[RPC]').slice(0,1600));
  process.exitCode=1;
});
