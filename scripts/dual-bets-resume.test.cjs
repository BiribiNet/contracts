'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getCreateAddress } = require('ethers');
const { remainingDeployments } = require('./dual-bets-resume.cjs');

const from = '0x0000000000000000000000000000000000000001';
const create = nonce => getCreateAddress({ from, nonce });
const definitions = [
    { name: 'Payout', build: () => ({ data: 'payout' }) },
    { name: 'Scanner', build: addresses => ({ data: addresses.Payout }) },
    { name: 'Engine', build: addresses => ({ data: addresses.Scanner }) },
];
const candidates = { Payout: create(333), Scanner: create(334), Engine: create(335) };

test('reuses only the confirmed prefix and rebases the remaining nonces and links', async () => {
    const result = await remainingDeployments({
        definitions, candidates, reused: {}, from, nonce: 337, occupied: async () => false,
        matches: async def => def.name === 'Payout',
    });
    assert.deepEqual(result.verified, [{ name: 'Payout', address: create(333) }]);
    assert.deepEqual(result.transactions.map(step => [step.nonce, step.expectedCreateAddress, step.data]), [
        [337, create(337), create(333)], [338, create(338), create(337)],
    ]);
});

test('a stale descendant is rebuilt when its dependency moved', async () => {
    const result = await remainingDeployments({
        definitions, candidates, reused: {}, from, nonce: 340, occupied: async () => false,
        matches: async (def, _address, spec) => def.name === 'Scanner' && spec.data === candidates.Payout,
    });
    assert.deepEqual(result.verified, []);
    assert.equal(result.transactions[1].data, create(340));
    assert.equal(result.transactions[2].data, create(341));
});

test('refuses to plan a CREATE at an occupied address', async () => {
    await assert.rejects(remainingDeployments({
        definitions, candidates, reused: {}, from, nonce: 340, occupied: async () => true,
        matches: async () => false,
    }), /already has code/);
});
