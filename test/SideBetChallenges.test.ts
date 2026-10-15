import { viem, artifacts } from 'hardhat';
import { expect } from 'chai';
import { zeroAddress } from 'viem';
import { SIDE_BET_CHALLENGES, challengeActivationPlan } from '../scripts/utils/sideBetChallenges';
import { exactChallengeProbability } from '../scripts/utils/challengeProbability';
const samples = [
  { type: 9, count: 3, w: 5, yes: [1, 13, 25], no: [0, 1, 12, 0, 13] },
  { type: 10, count: 0, w: 6, yes: [0, 7, 0], no: [7, 7, 7, 0, 1, 2] },
  { type: 11, count: 0, w: 5, yes: [18, 18], no: [1, 2, 3, 4, 5] },
  { type: 12, count: 0, w: 5, yes: [26, 0], no: [0, 0, 0, 0, 0] },
  { type: 13, count: 5, w: 6, yes: [0, 1, 2, 3, 4], no: [0, 0, 1, 2, 3, 3] },
  { type: 14, count: 3, w: 7, yes: [1, 0, 3, 5], no: [2, 4, 6, 1, 3, 5, 0] },
];
const bet = (s: (typeof samples)[number]) => ({
  player: zeroAddress,
  marketId: 1,
  stake: 1n,
  payout: 2n,
  startGlobalRound: 1n,
  windowSpins: s.w,
  betType: s.type,
  color: 0,
  targetNumber: 0,
  targetCount: s.count,
  redRatioBps: 0,
  status: 0,
  placedAt: 0n,
  resolvedAt: 0n,
});
describe('Original challenges', () => {
  let evaluator: Awaited<ReturnType<typeof viem.deployContract<'SideBetChallengeEvaluator'>>>;
  before(async () => {
    evaluator = await viem.deployContract('SideBetChallengeEvaluator');
  });
  for (const s of samples) {
    it('settles type ' + s.type + ' on its decisive prefix', async () => {
      expect(await evaluator.read.evaluate([s.yes, false, bet(s)])).to.deep.equal([true, true]);
    });
    it('rejects a losing full window for type ' + s.type, async () => {
      expect(await evaluator.read.evaluate([s.no, true, bet(s)])).to.deep.equal([true, false]);
    });
    it('keeps an empty prefix undecided for type ' + s.type, async () => {
      expect(await evaluator.read.evaluate([[], false, bet(s)])).to.deep.equal([false, false]);
    });
  }
  it('locks the first colour to reach the target, including black', async () => {
    expect(await evaluator.read.evaluate([[2, 4, 6, 1, 3, 5], false, bet(samples[5])])).to.deep.equal([true, false]);
    expect(await evaluator.read.evaluate([[2, 4, 6], false, { ...bet(samples[5]), color: 1 }])).to.deep.equal([
      true,
      true,
    ]);
  });
  it('includes 0+36 in mirror and excludes numerical neighbours that are not adjacent on the wheel', async () => {
    expect(await evaluator.read.evaluate([[0, 36], false, bet(samples[2])])).to.deep.equal([true, true]);
    expect(await evaluator.read.evaluate([[1, 2], false, bet(samples[3])])).to.deep.equal([false, false]);
  });
  it('both implementation and helper fit EIP-170 and init code fits EIP-3860', async () => {
    for (const name of ['SideBet', 'SideBetChallengeEvaluator']) {
      const a = await artifacts.readArtifact(name);
      expect((a.deployedBytecode.length - 2) / 2).to.be.at.most(24576);
      expect((a.bytecode.length - 2) / 2).to.be.at.most(49152);
    }
  });
  it('reproduces exact counts and rounds gross multipliers down', () => {
    const kinds = ['PASSPORT', 'BOOMERANG', 'MIRROR', 'NEIGHBORS', 'COLLECTION', 'DUEL'];
    SIDE_BET_CHALLENGES.forEach((c, i) => {
      const r = exactChallengeProbability(kinds[i], c.windowSpins, c.targetCount);
      expect(r.wins.toString()).eq(c.numerator);
      expect(r.total.toString()).eq(c.denominator);
      expect(Number((BigInt(10000 - c.houseEdgeBps) * r.total) / r.wins)).eq(c.multiplierBps);
      expect(c.multiplierBps).greaterThan(10000);
    });
  });
  it('does not misrepresent the existing 5x band as compatible', () => {
    expect(
      challengeActivationPlan(50000, 5000000)
        .filter((c) => c.compatibleBand)
        .map((c) => c.type),
    ).deep.eq(['BOOMERANG', 'MIRROR_PAIR']);
  });
  it('matches closed forms for short windows', () => {
    expect(exactChallengeProbability('BOOMERANG', 3).wins).eq(37n * 36n);
    expect(exactChallengeProbability('MIRROR', 2).wins).eq(37n);
    expect(exactChallengeProbability('NEIGHBORS', 2).wins).eq(74n);
    expect(exactChallengeProbability('PASSPORT', 3).wins).eq(6n * 12n ** 3n);
  });
});
