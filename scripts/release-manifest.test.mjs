import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseDefaults } from './release-manifest.mjs';
const bank = '0x1111111111111111111111111111111111111111';
const authority = '0x2222222222222222222222222222222222222222';
const keeper = () => ({ defaultMarket: 'brb', markets: { brb: { bank } }, automation: { mode: 'keeper' }, addresses: { creExecutionAuthority: authority } });
test('BRB-only keeper deployment does not require USDC or a CRE receiver', () => {
  assert.deepEqual(releaseDefaults(keeper()), { mode: 'keeper', market: { bank }, receiver: '' });
});
test('legacy CRE manifests keep their USDC default and require their receiver', () => {
  const m = { markets: { usdc: { bank } }, addresses: { creExecutionAuthority: authority, automationReceiver: bank } };
  assert.equal(releaseDefaults(m).receiver, bank);
  delete m.addresses.automationReceiver;
  assert.throws(() => releaseDefaults(m), /CRE requires/);
});
test('rejects unknown mode, wrong default, zero bank and mixed keeper/CRE settings', () => {
  for (const change of [{ defaultMarket: 'usdc' }, { defaultMarket: '__proto__' }, { automation: { mode: 'typo' } }, { markets: { brb: { bank: '0x' + '0'.repeat(40) } } }, { addresses: { creExecutionAuthority: authority, automationReceiver: bank } }]) {
    assert.throws(() => releaseDefaults({ ...keeper(), ...change }));
  }
});
