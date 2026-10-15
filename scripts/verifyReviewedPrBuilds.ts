import { artifacts, ethers } from 'hardhat';
import { vars } from 'hardhat/config';
import { Etherscan } from '@nomicfoundation/hardhat-verify/internal/etherscan';
import { readFileSync, writeFileSync } from 'node:fs';

async function main() {
  const journal = JSON.parse(readFileSync('deployments/pr-rollout-2026-10-09-live.json','utf8'));
  const api = new Etherscan(vars.get('ETHERSCAN_API_KEY'),'https://api.etherscan.io/v2/api','https://sepolia.arbiscan.io',421614);
  const results:any[]=[];
  const entries = Object.entries(journal.deployments) as [string,any][];
  for (const [name,data] of entries) {
    try {
      if (!await api.isVerified(data.address)) {
        const artifact=await artifacts.readArtifact(name);
        const fq=`${artifact.sourceName}:${artifact.contractName}`;
        const build=await artifacts.getBuildInfo(name==='SideBetChallengeEvaluator'?'contracts/SideBet.sol:SideBet':fq);
        if (!build) throw new Error('Missing exact build');
        const input=JSON.parse(JSON.stringify(build.input));
        input.settings.libraries={};
        for (const [library,address] of Object.entries(data.libraries)) {
          const index=library.lastIndexOf(':');
          const source=library.slice(0,index), contract=library.slice(index+1);
          input.settings.libraries[source] ??={};
          input.settings.libraries[source][contract]=address;
        }
        const submission=await api.verify(data.address,JSON.stringify(input),fq,`v${build.solcLongVersion}`,new ethers.Interface(artifact.abi).encodeDeploy(data.args).slice(2));
        const status=await api.getVerificationStatus(submission.message);
        if (!status.isSuccess() && !status.isAlreadyVerified()) throw new Error(status.message);
      }
      results.push({name,address:data.address,verified:true});
    } catch(e:any) {
      results.push({name,address:data.address,verified:/already verified/i.test(e.message),error:e.message.split('\n')[0]});
    }
    writeFileSync('deployments/pr-verification-2026-10-09.json',JSON.stringify(results,null,2)+'\n');
    console.log(name,results[results.length-1]);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
main().catch(()=>{console.error('Build verification stopped; inspect saved results');process.exitCode=1;});
