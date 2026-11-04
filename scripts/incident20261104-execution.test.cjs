const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertExecutionNetwork,executeRecovery}=require('./incident20261104-execution.cjs');
const provider=(chain,metadata)=>({send:async method=>{
  if(method==='eth_chainId')return '0x'+chain.toString(16);
  if(method==='hardhat_metadata'){if(metadata instanceof Error)throw metadata;return metadata;}
  throw Error('Unexpected RPC method: '+method);
}});
test('accepts local chain 31337 backed by Arbitrum 42161',async()=>{
  assert.equal(await assertExecutionNetwork(provider(31337,{chainId:31337,forkedNetwork:{chainId:42161}}),'fork'),31337);
});
test('fork mode rejects a mainnet execution provider before touching the signer',async()=>{
  await assert.rejects(executeRecovery({provider:provider(42161),mode:'fork',signer:{getAddress:()=>{throw Error('Signer must not be touched');}}}),/Unexpected execution chain/);
});
test('fork mode requires actual Hardhat metadata',async()=>{
  await assert.rejects(assertExecutionNetwork(provider(31337,Error('Unsupported')),'fork'),/Unsupported/);
});
test('fork mode rejects another source chain',async()=>{
  await assert.rejects(assertExecutionNetwork(provider(31337,{chainId:31337,forkedNetwork:{chainId:1}}),'fork'),/Arbitrum mainnet fork/);
});
test('mainnet mode rejects chain 31337',async()=>{
  await assert.rejects(assertExecutionNetwork(provider(31337),'mainnet'),/Unexpected execution chain/);
});
test('mainnet mode is gated by explicit confirmation',async()=>{
  const previous=process.env.INCIDENT_MAINNET_CONFIRM;delete process.env.INCIDENT_MAINNET_CONFIRM;
  try {await assert.rejects(assertExecutionNetwork(provider(42161,Error('Unsupported')),'mainnet'),/explicit confirmation/);}
  finally {if(previous===undefined)delete process.env.INCIDENT_MAINNET_CONFIRM;else process.env.INCIDENT_MAINNET_CONFIRM=previous;}
});
test('unknown execution mode fails closed',async()=>{
  await assert.rejects(assertExecutionNetwork(provider(42161),'automatic'),/explicitly/);
});
test('mainnet guard accepts 42161 only with confirmation and without Hardhat metadata',async()=>{
  const previous=process.env.INCIDENT_MAINNET_CONFIRM;process.env.INCIDENT_MAINNET_CONFIRM='arbitrum-one:42161';
  try {assert.equal(await assertExecutionNetwork(provider(42161,Error('Unsupported')),'mainnet'),42161);}
  finally {if(previous===undefined)delete process.env.INCIDENT_MAINNET_CONFIRM;else process.env.INCIDENT_MAINNET_CONFIRM=previous;}
});
test('mainnet mode rejects a Hardhat fork even if configured as chain 42161',async()=>{
  const previous=process.env.INCIDENT_MAINNET_CONFIRM;process.env.INCIDENT_MAINNET_CONFIRM='arbitrum-one:42161';
  try {await assert.rejects(assertExecutionNetwork(provider(42161,{chainId:42161,forkedNetwork:{chainId:42161}}),'mainnet'),/cannot use a Hardhat node/);}
  finally {if(previous===undefined)delete process.env.INCIDENT_MAINNET_CONFIRM;else process.env.INCIDENT_MAINNET_CONFIRM=previous;}
});
test('a different signer is rejected before loading artifacts or submitting transactions',async()=>{
  await assert.rejects(executeRecovery({provider:provider(31337,{chainId:31337,forkedNetwork:{chainId:42161}}),mode:'fork',
    signer:{getAddress:async()=>'0x0000000000000000000000000000000000000001'}}));
});
