import hre from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
async function main() {
  const journal = JSON.parse(readFileSync('deployments/rollout-2026-10-09-live.json','utf8'));
  const output = `deployments/verification-${process.env.VERIFY_GROUP || 'all'}-2026-10-09.json`;
  const results: any[] = [];
  for (const [name, data] of [...Object.entries(journal.deployments), ['SideBetChallengeEvaluator', {address:journal.challengeEvaluator,args:[],libraries:{}}]] as [string,any][]) {
    if (process.env.VERIFY_ONLY && !process.env.VERIFY_ONLY.split(',').includes(name.split(':').pop()!)) continue;
    try {
      await hre.run('verify:verify',{address:data.address,constructorArguments:data.args,libraries:data.libraries});
      results.push({name,address:data.address,verified:true});
    } catch (e:any) {
      const already = /already verified/i.test(e.message);
      results.push({name,address:data.address,verified:already,...(!already?{error:e.message.split('\n')[0]}:{})});
    }
    writeFileSync(output,JSON.stringify(results,null,2)+'\n');
    console.log(name,results[results.length-1].verified?'VERIFIED':'FAILED');
    await new Promise(resolve=>setTimeout(resolve,1200));
  }
}
main().catch(()=>{console.error('Verification stopped; inspect saved results');process.exitCode=1;});
