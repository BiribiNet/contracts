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

function fixture(reorg = false) {
  const address = '0x' + '1'.repeat(40);
  const hash = '0x' + '2'.repeat(64);
  let blocks = 0;
  const client = {
    getChainId: async () => 421614,
    getBlock: async (args) => {
      if (args) assert.equal(args.blockNumber, 123n);
      return { number: 123n, timestamp: 456n, hash: reorg && blocks++ > 0 ? '0x' + '3'.repeat(64) : hash };
    },
    getStorageAt: async args => { assert.equal(args.blockNumber, 123n); return '0x' + '0'.repeat(24) + '1'.repeat(40); },
    getBytecode: async args => { assert.equal(args.blockNumber, 123n); return '0x6000'; },
    readContract: async args => {
      assert.equal(args.blockNumber, 123n);
      const values = {
        VRF_SUBSCRIPTION_ID: 5n, hasPendingVrf: false, currentGlobalRound: 12n,
        VRF_CALLBACK_GAS_LIMIT: 2500000, UPKEEP_SCHEDULER: address, vaultBeacon: address,
        marketCount: 1, implementation: address, owner: address,
        getMarket: { asset: address, bank: address }, totalAssets: 7n, totalSupply: 8n,
        lockedBetLiquidity: 3n, balanceOf: 10n,
        getSubscription: [1n, 0n, 9n, address, [address]],
      };
      assert.ok(args.functionName in values);
      return values[args.functionName];
    },
  };
  return { client, config: { addresses: { roulette: address, registry: address }, vrf: { coordinator: address } } };
}
test('pins all reads and keeps locked funds separate without approving an upgrade', async () => {
  const { client, config } = fixture();
  const report = await inspectProtocol(client, config);
  assert.equal(report.blockNumber, 123n);
  assert.equal(report.vaults.banks[0].locked, 3n);
  assert.equal(report.vaults.banks[0].tokenBalance, 10n);
  assert.equal(report.upgradeApproved, false);
});
test('rejects a changed block hash instead of saving inconsistent evidence', async () => {
  const { client, config } = fixture(true);
  await assert.rejects(inspectProtocol(client, config), /Pinned block changed/);
});
