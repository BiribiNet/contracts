// Offline guards of the mask-bets v1 upgrade/activation scripts (no RPC, no compilation, no key).
// The full preflight/plan/execution runs on the local Hardhat network in test/MaskBetsMainnetUpgradeScript.test.ts.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('./mask-bets-v1-common.cjs');
const Upgrade=require('./mask-bets-v1-mainnet.cjs');
const Activate=require('./mask-bets-v1-activate.cjs');

const provider=(chain,metadata)=>({send:async method=>{
  if(method==='eth_chainId')return '0x'+chain.toString(16);
  if(method==='hardhat_metadata'){if(metadata instanceof Error)throw metadata;return metadata;}
  throw Error('Unexpected RPC method: '+method);
}});
const withEnv=async(name,value,body)=>{
  const previous=process.env[name];
  if(value===undefined)delete process.env[name];else process.env[name]=value;
  try {return await body();} finally {if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
};

test('mainnet mode accepts chain 42161 without Hardhat metadata',async()=>{
  assert.equal(await C.assertNetwork(provider(42161,Error('unsupported')),'mainnet'),42161);
});
test('mainnet mode rejects another chain and any Hardhat node or fork',async()=>{
  await assert.rejects(C.assertNetwork(provider(421614,Error('x')),'mainnet'),/Unexpected chain/);
  await assert.rejects(C.assertNetwork(provider(42161,{chainId:42161,forkedNetwork:{chainId:42161}}),'mainnet'),/Hardhat node or fork/);
});
test('execution needs the typed confirmation',async()=>{
  await withEnv(C.CONFIRM_ENV,undefined,()=>assert.rejects(C.assertNetwork(provider(42161,Error('x')),'mainnet',{execute:true}),/MASK_BETS_V1_MAINNET_CONFIRM/));
  await withEnv(C.CONFIRM_ENV,'yes',()=>assert.rejects(C.assertNetwork(provider(42161,Error('x')),'mainnet',{execute:true}),/arbitrum-one:42161/));
  await withEnv(C.CONFIRM_ENV,C.MAINNET_CONFIRMATION,async()=>assert.equal(await C.assertNetwork(provider(42161,Error('x')),'mainnet',{execute:true}),42161));
});
test('local mode only accepts a non-forked Hardhat chain 31337',async()=>{
  assert.equal(await C.assertNetwork(provider(31337,{chainId:31337}),'local'),31337);
  await assert.rejects(C.assertNetwork(provider(31337,{chainId:31337,forkedNetwork:{chainId:42161}}),'local'),/refuses forks/);
  await assert.rejects(C.assertNetwork(provider(31337,Error('x')),'local'),/Hardhat network/);
  await assert.rejects(C.assertNetwork(provider(31337,{chainId:31337}),'automatic'),/explicitly/);
});
test('the dry-run provider refuses every sending or state-altering method',async()=>{
  const p=new C.ReadOnlyProvider('http://127.0.0.1:9',42161,{staticNetwork:true});
  try {
    for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','hardhat_setBalance','evm_mine'])
      assert.throws(()=>p.send(method,[]),/Read-only provider refused/);
  } finally {p.destroy();}
});
test('the operator key comes only from the environment and must be the admin key',async()=>{
  await withEnv(C.KEY_ENV,undefined,()=>assert.throws(()=>C.operatorSigner(null,'0x0000000000000000000000000000000000000001'),/MASK_BETS_V1_ADMIN_KEY/));
  // Hardhat's first public test key, never a real one.
  await withEnv(C.KEY_ENV,'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    ()=>assert.throws(()=>C.operatorSigner(null,'0x0000000000000000000000000000000000000001'),/not the protocol admin/));
});
test('runtime normalisation ignores metadata, library self-address and immutables only',()=>{
  const metadata=(tag)=>'a2646970667358'+tag.repeat(44)+'0033'; // 51-byte CBOR trailer + length
  const body='6080604052';
  assert.equal(C.normalizeRuntime('0x'+body+metadata('11')),C.normalizeRuntime('0x'+body+metadata('22')));
  assert.notEqual(C.normalizeRuntime('0x'+body+metadata('11')),C.normalizeRuntime('0x6080604053'+metadata('11')));
  const lib=address=>'0x73'+address+'3014'+body+metadata('11');
  assert.equal(C.normalizeRuntime(lib('11'.repeat(20)),{library:true}),C.normalizeRuntime(lib('22'.repeat(20)),{library:true}));
  const withImmutable=word=>'0x'+body+word+metadata('11');
  assert.equal(C.normalizeRuntime(withImmutable('aa'.repeat(32)),{immutables:[{start:5,length:32}]}),
    C.normalizeRuntime(withImmutable('bb'.repeat(32)),{immutables:[{start:5,length:32}]}));
  assert.deepEqual(C.immutableValues(withImmutable('aa'.repeat(32)),[{start:5,length:32}]),['0x'+'aa'.repeat(32)]);
});
test('linking replaces every placeholder and refuses a missing library',()=>{
  const placeholder='__$'+'0'.repeat(34)+'$__';
  const refs={'contracts/L.sol':{L:[{start:1,length:20}]}};
  assert.equal(C.link('0x60'+placeholder+'00',refs,{L:'0x'+'ab'.repeat(20)}),'0x60'+'ab'.repeat(20)+'00');
  assert.throws(()=>C.link('0x60'+placeholder+'00',refs,{}),/No address to link L/);
});
// Minimal solc-shaped dispatcher: selector load, then `DUP1 PUSHn s EQ PUSH2 t JUMPI` entries, then fallback.
const dispatcher=entries=>'0x'+'5f35'+'60e01c'+entries.map(([push,s])=>'80'+push+s+'14'+'610100'+'57').join('')+'5b5f5ffd';
test('selector detection reads the disassembled dispatcher, including selectors with a leading zero byte',()=>{
  const lock=require('ethers').id('lockSideBetStake(address,uint256,uint256)').slice(2,10);
  // 0x00e4a032 (drainWithdrawalQueue) is compared with PUSH3 e4a032: the old `63`+selector search missed it.
  const code=dispatcher([['62','e4a032'],['63',lock]]);
  assert.equal(C.dispatchesSelector(code,'drainWithdrawalQueue(uint256)'),true);
  assert.equal(C.dispatchesSelector(code,C.REMOVED_VAULT_FUNCTIONS[0]),true);
  assert.equal(C.dispatchesSelector(code,'setFlatWithdrawFee(uint256)'),false);
  assert.equal(code.includes('63'+'00e4a032'),false,'fixture must reproduce the PUSH3 encoding');
  // A selector hidden in PUSH data or after the table is not dispatched.
  assert.equal(C.dispatchesSelector(dispatcher([['63','12345678']])+'7f'+'63'+lock+'00'.repeat(27),C.REMOVED_VAULT_FUNCTIONS[0]),false);
  assert.throws(()=>C.dispatcherSelectors('0x6080604052'),/No solc selector dispatcher/);
});
test('the live vault runtime 0x6e84…f3cC dispatches exactly the ABI of its reconstructed source, drain and fee setter included',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const dir=path.join(C.ROOT,'reports/vault-2026-11-05');
  const code=fs.readFileSync(path.join(dir,'onchain-runtime-0x6e84c0ed.hex'),'utf8').trim();
  const abi=JSON.parse(fs.readFileSync(path.join(dir,'abi.json'),'utf8'));
  const {Interface}=require('ethers'),expected=[];
  new Interface(abi).forEachFunction(f=>expected.push(f.selector));
  assert.deepEqual([...C.dispatcherSelectors(code)].sort(),expected.sort());
  for(const signature of ['setFlatWithdrawFee(uint256)','drainWithdrawalQueue(uint256)',...C.REMOVED_VAULT_FUNCTIONS])assert.equal(C.dispatchesSelector(code,signature),true,signature);
  assert.equal(C.lower(code).includes('63'+'00e4a032'),false,'drainWithdrawalQueue is PUSH3-encoded on chain');
});
test('the mainnet manifest yields the live engine constructor arguments and the reviewed redeploy set',()=>{
  const d=C.loadMainnetDeployment();
  assert.equal(d.chainId,42161);
  assert.equal(d.engineConstructorArgs.length,6);
  assert.equal(C.lower(d.beacon),'0x7b23ccddb62b982245c50bdaaf1d13b3d12d632b');
  assert.deepEqual([...d.expectedRedeploy].sort(),['RouletteLiabilityMathLib','RouletteMaskBetLib','RoulettePayoutSweepLib','RouletteUpkeepScanLib']);
  assert.equal(d.linkedLibraries.rouletteMaskBetLib,undefined);
});
test('upgrade CLI: dry run by default, unknown flags rejected, --out only for a dry run',()=>{
  assert.equal(Upgrade.parseArgs([]).mode,'dry-run');
  assert.equal(Upgrade.parseArgs(['--execute']).mode,'execute');
  assert.throws(()=>Upgrade.parseArgs(['--force']),/Unknown argument/);
  assert.throws(()=>Upgrade.parseArgs(['--execute','--out','x.json']),/dry-run option/);
});
test('activation CLI: explicit values only, bounded, launch cap enforced',()=>{
  assert.throws(()=>Activate.parseArgs([]),/no default values/);
  assert.throws(()=>Activate.parseArgs(['--market','1']),/Expected --market/);
  assert.throws(()=>Activate.parseArgs(['--market','1:449:1000']),/launch cap 448/);
  assert.throws(()=>Activate.parseArgs(['--market','1:448:1000','--market','1:10:10']),/once/);
  assert.equal(Activate.parseArgs(['--market','2:0:0','--print-calldata']).mode,'print-calldata');
  assert.deepEqual(Activate.parseArgs(['--market','1:448:1000']).settings,[{marketId:1,maxLegsPerRound:448,maxLiabilityBps:1000}]);
  assert.equal(C.LAUNCH_MASK_LEG_CAP,448);
});
test('the manifest points at the proven live vault 0x6e84…f3cC and expects its archived runtime',()=>{
  const fs=require('node:fs'),path=require('node:path'),{keccak256}=require('ethers');
  const d=C.loadMainnetDeployment();
  assert.equal(C.lower(d.bankVaultImplementation),'0x6e84c0ed4056ba6e94dff5008abe811738f8f3cc');
  const archived=fs.readFileSync(path.join(C.ROOT,'reports/vault-2026-11-05/onchain-runtime-0x6e84c0ed.hex'),'utf8').trim();
  assert.equal(d.bankVaultRuntimeHash,keccak256(archived));
});
test('the preflight refuses a vault build that drops setFlatWithdrawFee or drainWithdrawalQueue',()=>{
  const sel=s=>require('ethers').id(s).slice(2,10);
  const both=dispatcher([['62','e4a032'],['63',sel('setFlatWithdrawFee(uint256)')]]);
  assert.deepEqual(Upgrade.assertKeptVaultFunctions(both,'build'),C.KEPT_VAULT_FUNCTIONS);
  assert.throws(()=>Upgrade.assertKeptVaultFunctions(dispatcher([['62','e4a032']]),'build'),/no longer dispatches setFlatWithdrawFee/);
  assert.throws(()=>Upgrade.assertKeptVaultFunctions(dispatcher([['63',sel('setFlatWithdrawFee(uint256)')]]),'build'),/no longer dispatches drainWithdrawalQueue/);
});
