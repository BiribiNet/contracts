#!/usr/bin/env node
// Explorer source publication only. This script has no wallet and rejects transaction/signing RPCs.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {JsonRpcProvider,keccak256}=require('ethers');
const {archiveRpc,compiler}=require('./incident20261104.cjs');
const ROOT=path.resolve(__dirname,'..'),DIR=path.join(ROOT,'reports/incident-2026-11-04');
const journal=JSON.parse(fs.readFileSync(path.join(DIR,'mainnet-execution-2026-11-04T18-59-44-816Z.json')));
const nativeSolc=compiler();
const targets=[
  {key:'cleanBank',name:'BankVault4626',revision:'clean',label:'Deploy bank without recovery'},
  {key:'cleanSide',name:'SideBet',revision:'clean',label:'Deploy SideBet without recovery'},
  {key:'recoveryBank',name:'BankVault4626',revision:'recovery',label:'Deploy recovery bank'},
  {key:'recoverySide',name:'SideBet',revision:'recovery',label:'Deploy recovery SideBet'},
];
class ReadOnlyProvider extends JsonRpcProvider {
  send(method,params) {
    assert(!/send|sign|personal|hardhat|anvil|evm_/i.test(method),'Read-only verification provider');
    return super.send(method,params);
  }
}
async function main() {
  require('ts-node/register');process.env.HARDHAT_CONFIG=path.join(ROOT,'hardhat.incident.config.ts');require('hardhat');
  const {vars}=require('hardhat/config');
  assert(vars.has('ETHERSCAN_API_KEY'),'Explorer API credential missing');
  assert.equal(journal.status,'passed');assert(fs.existsSync(nativeSolc),'Native compiler missing');
  const key=vars.get('ETHERSCAN_API_KEY');
  const provider=new ReadOnlyProvider(archiveRpc(),42161,{staticNetwork:true});
  const report={status:'running',chainId:42161,blockchainTransactionsSent:false,contracts:[]};
  const persist=()=>fs.writeFileSync(path.join(DIR,'explorer-verification.json'),JSON.stringify(report,null,2)+'\n');
  let lastApiRequest=0;
  async function explorerApi(action,fields,post=false) {
    const url=new URL('https://api.etherscan.io/v2/api');
    const parameters=new URLSearchParams({apikey:key,module:'contract',action,...fields});
    if(post)url.search=new URLSearchParams({chainid:'42161'});
    else {parameters.set('chainid','42161');url.search=parameters;}
    for(let attempt=0;attempt<4;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,550-(Date.now()-lastApiRequest))));
      lastApiRequest=Date.now();
      const response=await fetch(url,{signal:AbortSignal.timeout(30000),...(post?{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:parameters.toString(),
      }:{})});
      assert.equal(response.status,200,'Explorer HTTP request failed');const body=await response.json();
      if(/rate limit/i.test(String(body.result))&&attempt<3){await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));continue;}
      return body;
    }
  }
  async function sourceStatus(address) {
    const body=await explorerApi('getsourcecode',{address});
    assert.equal(body.status,'1','Explorer source query failed');
    const row=body.result[0];
    return {sourcePresent:!!row.SourceCode,contractName:row.ContractName,compilerVersion:row.CompilerVersion,
      similarMatch:row.SimilarMatch||'',exactMatch:!!row.SourceCode&&!row.SimilarMatch};
  }
  try {
    assert.equal(Number(BigInt(await provider.send('eth_chainId',[]))),42161);
    // Validate every compiler input against its actual deployment before publishing any source.
    for(const t of targets) {
      t.input=JSON.parse(fs.readFileSync(path.join(DIR,'compiler-inputs',t.name+'-'+t.revision+'.json')));
      const input=JSON.parse(JSON.stringify(t.input));
      input.settings.outputSelection={['contracts/'+t.name+'.sol']:{[t.name]:['abi','evm.bytecode']}};
      const compiled=spawnSync(nativeSolc,['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:64*1024*1024});
      assert.equal(compiled.status,0,'Compiler failed');const output=JSON.parse(compiled.stdout);
      assert(!(output.errors||[]).some(e=>e.severity==='error'),'Compiler input is invalid');
      const artifact=output.contracts['contracts/'+t.name+'.sol'][t.name];
      assert.equal(artifact.abi.find(row=>row.type==='constructor')?.inputs.length||0,0,'Unexpected constructor arguments');
      const bytecode='0x'+artifact.evm.bytecode.object;
      assert.equal(keccak256(bytecode),journal.artifactHashes[t.key],'Compiler input differs from deployed artifact');
      t.address=journal.implementations[t.key].address;
      const tx=await provider.getTransaction(journal.transactions.find(row=>row.label===t.label).hash);
      assert.equal(tx.data,bytecode,'Deployment transaction input differs');
      assert.equal(keccak256(await provider.getCode(t.address)),journal.implementations[t.key].runtimeHash,'Deployed runtime changed');
    }
    report.allCompilerInputsReproduceDeploymentBytecode=true;
    const withoutMetadata=hex=>{
      const bytes=Buffer.from(hex.slice(2),'hex'),length=bytes.readUInt16BE(bytes.length-2);
      assert(length+2<bytes.length,'Invalid Solidity metadata trailer');return bytes.subarray(0,bytes.length-length-2);
    };
    const originalBank=require('../test/fixtures/BankVault4626.pre-2026-11-04.json');
    report.cleanBankExecutableMatchesOriginal=withoutMetadata(await provider.getCode(journal.implementations.cleanBank.address))
      .equals(withoutMetadata(originalBank.deployedBytecode));
    assert.equal(report.cleanBankExecutableMatchesOriginal,true,'Cleanup bank executable differs from the original');
    for(const t of targets) {
      const row={key:t.key,address:t.address,url:'https://arbiscan.io/address/'+t.address+'#code',status:'checking'};
      report.contracts.push(row);persist();
      try {
        row.before=await sourceStatus(t.address);
        if(!row.before.exactMatch) {
          console.log('Submitting exact source: '+t.key+' '+t.address);
          try {
            const submission=await explorerApi('verifysourcecode',{
              contractaddress:t.address,sourceCode:JSON.stringify(t.input),codeformat:'solidity-standard-json-input',
              contractname:'contracts/'+t.name+'.sol:'+t.name,compilerversion:'v0.8.27+commit.40a35a09',constructorArguements:'',
            },true);
            if(submission.status!=='1')throw Error(String(submission.result));
            row.submissionId=submission.result;persist();
            for(let attempt=0;attempt<20;attempt++) {
              const result=await explorerApi('checkverifystatus',{guid:submission.result});
              row.result=result.result;
              if(/pending in queue/i.test(result.result)){await new Promise(resolve=>setTimeout(resolve,3000));continue;}
              if(result.status!=='1'&&!/already verified/i.test(result.result))throw Error(String(result.result));
              break;
            }
            assert(/pass - verified|already verified/i.test(row.result),'Explorer verification did not finish successfully');
          } catch(error) {
            if(!/already verified/i.test(error.message))throw error;
            row.result='Already verified';
          }
        }
        for(let attempt=0;attempt<4;attempt++) {
          row.after=await sourceStatus(t.address);
          if(row.after.exactMatch)break;
          if(attempt<3)await new Promise(resolve=>setTimeout(resolve,2000));
        }
        assert(row.after.sourcePresent,'Explorer has not published verified source');
        row.status=row.after.exactMatch?'verified':'verified-similar';
        if(!row.after.exactMatch)row.note='Explorer retains Similar Match and returns Already Verified for exact resubmission. Exact compiler-input/deployment reproduction was checked independently.';
        console.log((row.after.exactMatch?'Exact source verified: ':'Similar Match source available: ')+t.key+' '+t.address);
      } catch(error) {
        row.status='failed';row.error=String(error.shortMessage||error.message).replace(/https?:\/\/\S+/g,'[API]').slice(0,1000);
        console.error(t.key+': '+row.error);
      }
      persist();
    }
    report.allExactMatches=report.contracts.every(row=>row.status==='verified');
    report.status=report.contracts.every(row=>['verified','verified-similar'].includes(row.status))?'passed':'partial';persist();
    assert.equal(report.status,'passed','Some implementations have no verified source; inspect the report');
  } finally {await provider.destroy();}
}
main().catch(error=>{console.error(String(error.shortMessage||error.message).replace(/https?:\/\/\S+/g,'[API]').slice(0,1000));process.exitCode=1;});
