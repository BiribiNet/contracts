#!/usr/bin/env node
// Production entry point. --fork executes the exact same recovery sequence on local chain 31337.
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {executeRecovery}=require('./incident20261104-execution.cjs');
const {prepareValidation,archiveRpc}=require('./incident20261104.cjs');
const ROOT=path.resolve(__dirname,'..');
const CONFIG=path.join(ROOT,'hardhat.incident.config.ts');
const DIR=path.join(ROOT,'reports/incident-2026-11-04');
const HARDHAT=path.join(ROOT,'node_modules/hardhat/internal/cli/cli.js');
async function main() {
  const args=process.argv.slice(2);
  assert(args.length===1&&['--fork','--mainnet'].includes(args[0]),'Usage: node scripts/incident20261104-mainnet.cjs --fork | --mainnet');
  const mode=args[0].slice(2);
  if(mode==='mainnet')assert.equal(process.env.INCIDENT_MAINNET_CONFIRM,'arbitrum-one:42161','Mainnet disabled without explicit confirmation; nothing sent');
  process.chdir(ROOT);
  const env={...process.env,HARDHAT_CONFIG:CONFIG,HARDHAT_NETWORK:'hardhat',REPORT_GAS:'false'};
  const run=(args,extra={})=>{
    const result=spawnSync(process.execPath,[HARDHAT,...args,'--config',CONFIG],{cwd:ROOT,env:{...env,...extra},stdio:'inherit'});
    assert.equal(result.status,0,'Validation or execution failed; inspect the transaction journal before any retry');
  };
  run(['compile']);prepareValidation();
  const guards=spawnSync(process.execPath,['--test','scripts/incident20261104-execution.test.cjs'],{cwd:ROOT,env,stdio:'inherit'});
  assert.equal(guards.status,0,'Execution guard tests failed');
  run(['test','--no-compile','test/BankVaultDrainIncident.test.ts','test/BankVaultIncidentRecovery.test.ts',
    'test/SideBetIncidentDisabled.test.ts','test/BankVault4626.test.ts','test/BankVaultIncident20261104.test.ts',
    'test/IncidentPostCleanup.test.ts']);
  if(mode==='fork') {
    const relay=spawn(process.execPath,[path.join(ROOT,'scripts/incident20261104.cjs')],
      {cwd:ROOT,env:{...env,INCIDENT_20261104_READ_RELAY:'1'},stdio:['ignore','ignore','inherit','ipc']});
    const relayUrl=await new Promise((resolve,reject)=>{
      relay.once('message',m=>resolve(m.url));relay.once('error',reject);
      relay.once('exit',code=>reject(Error('Read-only relay exited: '+code)));
    });
    try {run(['run','--no-compile',path.join(ROOT,'scripts/incident20261104-fork.cjs')],{INCIDENT_20261104_FORK_CHILD:'1',INCIDENT_FORK_URL:relayUrl,RUST_LOG:'off'});}
    finally {relay.kill('SIGTERM');}
    console.log('PRODUCTION SCRIPT PASSED ON LOCAL FORK 31337. No mainnet transactions sent.');
    return;
  }
  // Reached only with --mainnet and explicit confirmation. Never used by the fork wrapper.
  const {JsonRpcProvider,Wallet}=require('ethers');
  const provider=new JsonRpcProvider(archiveRpc(),42161,{staticNetwork:true});
  const {vars}=require('hardhat/config');
  assert(vars.has('BRB_KEY'),'Configure the administrator signer in Hardhat vars');
  const signer=new Wallet(vars.get('BRB_KEY'),provider);
  const sourceBlock=await provider.getBlockNumber();
  const reportPath=path.join(DIR,'mainnet-execution-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  try {await executeRecovery({provider,signer,mode:'mainnet',sourceBlock,reportPath});}
  finally {await provider.destroy();}
}

if(require.main===module) {
  main().catch(error=>{console.error(String(error.shortMessage||error.message).replace(/https?:\/\/\S+/g,'[RPC]').slice(0,1600));process.exitCode=1;});
}
