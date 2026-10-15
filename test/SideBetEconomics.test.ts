import { expect } from 'chai';
import { simulateSideBetEconomics } from '../scripts/utils/sideBetEconomics';

describe('SideBet economic model', () => {
  it('accounts for fees on losing tickets rather than on expected net house profit', () => {
    const input = { probability: 0.0095, multiplierBps: 1000000, stake: 1000000n,
      tickets: 10000, seed: 9127, feeBps: 500n };
    const a = simulateSideBetEconomics(input);
    expect(a).to.deep.equal(simulateSideBetEconomics(input));
    expect(a.expectedNetStakeFraction).to.be.closeTo(0.000475, 1e-12);
    expect(BigInt(a.stakes) - BigInt(a.paid) - BigInt(a.ticketPolicy.fees)).to.equal(BigInt(a.ticketPolicy.lpNet));
    expect(a.allWinAdditionalReserve).to.equal((99n * input.stake * 10000n).toString());
    expect(BigInt(a.ticketPolicy.fees)).to.be.gte(BigInt(a.batchPolicy.fees));
  });
  it('preserves equivalent results in six and eighteen decimal assets', () => {
    const a = simulateSideBetEconomics({ probability: 0.01, multiplierBps: 950000, stake: 1000000n, tickets: 1000, seed: 1, feeBps: 500n });
    const b = simulateSideBetEconomics({ probability: 0.01, multiplierBps: 950000, stake: 10n ** 18n, tickets: 1000, seed: 1, feeBps: 500n });
    expect(BigInt(b.ticketPolicy.lpNet)).to.equal(BigInt(a.ticketPolicy.lpNet) * 10n ** 12n);
    expect(() => simulateSideBetEconomics({ probability: 2, multiplierBps: 950000, stake: 1n, tickets: 1, seed: 1, feeBps: 500n })).to.throw();
  });
});
