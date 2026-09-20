import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes, toHex } from 'viem';
import { slotAddress, assessVrf, inspectProtocol, IMPLEMENTATION_SLOT, BEACON_SLOT } from './protocol-preflight.mjs';

test('proxy slots match ERC-1967 derivation', () => {
  for (const [name, slot] of [['implementation', IMPLEMENTATION_SLOT], ['beacon', BEACON_SLOT]]) {
    assert.equal(toHex(BigInt(keccak256(toBytes(`eip1967.proxy.${name}`))) - 1n, { size: 32 }), slot);
  }
});
test('rejects absent, empty and non-address storage instead of inventing an implementation', () => {
  for (const value of [undefined, '0x', '0x' + '0'.repeat(64), '0x' + 'f'.repeat(64)]) {
    assert.throws(() => slotAddress(value));
  }
  assert.equal(slotAddress('0x' + '0'.repeat(24) + '1'.repeat(40)), '0x' + '1'.repeat(40));
});
test('detects empty subscription and unregistered consumer independently', () => {
  assert.deepEqual(assessVrf({ balance: 0n, consumers: [], engine: '0xabc', pending: true }).issues,
    ['ENGINE_NOT_REGISTERED', 'SUBSCRIPTION_LINK_EMPTY', 'VRF_REQUEST_PENDING']);
});
test('a positive subscription balance is not a funding guarantee', () => {
  const result = assessVrf({ balance: 1n, consumers: ['0xAbC'], engine: '0xabc', pending: false });
  assert.deepEqual(result.issues, []);
  assert.equal(result.fundingSufficient, null);
});
test('wrong chain fails before reading protocol state', async () => {
  await assert.rejects(inspectProtocol({ getChainId: async () => 1 }, {}), /Expected Arbitrum Sepolia/);
});
