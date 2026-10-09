import { viem } from 'hardhat';
import { expect } from 'chai';
import { parseUnits } from 'viem';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import pricingReport from '../docs/side-bet-x100-pricing.json';
import {
  X100_OFFERS,
  X100_TEMPLATES,
  assertX100Pricing,
  buildX100CatalogueForMarket,
  hitProbability,
  streakProbability,
} from '../scripts/utils/sideBetX100Catalogue';
import {
  MIN_MULTIPLIER_BPS,
  MAX_MULTIPLIER_BPS,
  matchesConfig,
  toConfigStruct,
  computeMaxStake,
} from '../scripts/utils/sideBetCatalogue';
import { deploySideBetProxy, deploySideBetRegistryStack } from './helpers/deploySideBetRegistryStack';

const units = (value: string) => parseUnits(value, 6);
async function fixture() {
  const [admin, player] = await viem.getWalletClients();
  const token = await viem.deployContract('MockUSDC');
  const engine = await viem.deployContract('MockRoundEngine');
  const implementation = await viem.deployContract('BankVault4626');
  const beacon = await viem.deployContract('UpgradeableBeacon', [implementation.address, admin.account.address]);
  const { registry } = await deploySideBetRegistryStack({ admin: admin.account.address, roundEngine: engine.address });
  const { sideBet } = await deploySideBetProxy({
    admin: admin.account.address,
    roundEngine: engine.address,
    registry: registry.address,
    minMultiplierBps: MIN_MULTIPLIER_BPS,
    maxMultiplierBps: MAX_MULTIPLIER_BPS,
  });
  await sideBet.write.grantRole([await sideBet.read.SETTLEMENT_ROLE(), admin.account.address]);
  await registry.write.setVaultBeacon([beacon.address]);
  await registry.write.createMarket([{ asset: token.address, bankAdmin: admin.account.address, minBet: units('1') }]);
  const market = await registry.read.getMarket([1]);
  const vault = await viem.getContractAt('BankVault4626', market.bank);
  await token.write.mint([admin.account.address, units('1000000')]);
  await token.write.approve([vault.address, units('1000000')]);
  await vault.write.deposit([units('1000000'), admin.account.address]);
  await token.write.mint([player.account.address, units('10000')]);
  await token.write.approve([vault.address, units('10000')], { account: player.account });
  return { admin, player, token, engine, sideBet, vault };
}

describe('X100 exact pricing', () => {
  it('keeps the generated pricing report synchronized', () => {
    expect(pricingReport).deep.eq(X100_OFFERS);
  });
  it('matches independent closed forms, including overlapping streaks', () => {
    expect(hitProbability(4, 4, 12).wins).eq(12n ** 4n);
    expect(hitProbability(6, 2, 1).wins).eq(37n ** 6n - 36n ** 6n - 6n * 36n ** 5n);
    expect(streakProbability(8, 7).wins).eq(2n * 18n ** 7n * 37n - 18n ** 8n);
    expect(hitProbability(10, 9, 18).wins).eq(10n * 18n ** 9n * 19n + 18n ** 10n);
  });

  it('prices at 5% with a strict rational tolerance and maximal floor multiplier', () => {
    assertX100Pricing();
    expect(X100_OFFERS.map((x) => x.multiplierBps)).deep.eq([858628, 932205, 973289, 1107197]);
    for (const offer of X100_OFFERS) {
      const wins = BigInt(offer.wins),
        total = BigInt(offer.total),
        m = BigInt(offer.multiplierBps);
      expect(m * wins).at.most(9500n * total);
      expect((m + 1n) * wins).greaterThan(9500n * total);
      expect((9500n * total - m * wins) * 1_000_000n).at.most(2n * total * 10000n);
      expect(offer.multiplierBps).within(MIN_MULTIPLIER_BPS, MAX_MULTIPLIER_BPS);
    }
  });

  it('covers 44 unique choices, all numbers including zero and both colours', () => {
    expect(X100_TEMPLATES).length(44);
    expect(new Set(X100_TEMPLATES.map((x) => x.key)).size).eq(44);
    expect(X100_TEMPLATES.filter((x) => x.betType === 1).map((x) => x.targetNumber)).deep.eq(
      Array.from({ length: 37 }, (_, i) => i),
    );
    for (const type of [0, 2])
      expect(X100_TEMPLATES.filter((x) => x.betType === type).map((x) => x.color)).deep.eq([0, 1]);
  });
});

describe('X100 real vault integration', () => {
  it('creates and activates all choices, recognizes them on rerun and places each ticket', async () => {
    const { sideBet, player } = await loadFixture(fixture);
    for (const entry of buildX100CatalogueForMarket(1)) {
      const id = await sideBet.read.configCount();
      await sideBet.write.addConfig([toConfigStruct(entry)]);
      const staged = await sideBet.read.getConfig([id]);
      expect(staged.minStake).eq(0n);
      await sideBet.write.setConfigStakeLimits([id, units('1'), units('10')]);
      expect(matchesConfig(entry, await sideBet.read.getConfig([id]))).eq(true);
      await sideBet.write.placeBet([id, units('1')], { account: player.account });
    }
    expect(await sideBet.read.configCount()).eq(44n);
    expect(await sideBet.read.betCount()).eq(44n);
  });

  const cases = [
    { key: 'PERFECT_DOZEN', color: 0, number: 1, yes: [1, 12, 3, 7], no: [1, 12, 7, 0] },
    { key: 'DOUBLE_NUMBER', color: 0, number: 7, yes: [7, 1, 2, 7], no: [7, 1, 2, 3, 4, 5] },
    { key: 'DOUBLE_NUMBER', color: 0, number: 0, yes: [0, 1, 0], no: [0, 1, 2, 3, 4, 5] },
    { key: 'SEVEN_STREAK', color: 0, number: 0, yes: [0, 1, 3, 5, 7, 9, 12, 14], no: [1, 3, 5, 0, 7, 9, 12, 14] },
    { key: 'SEVEN_STREAK', color: 1, number: 0, yes: [1, 2, 4, 6, 8, 10, 11, 13], no: [2, 4, 6, 0, 8, 10, 11, 13] },
    {
      key: 'NINE_OF_TEN',
      color: 0,
      number: 0,
      yes: [1, 3, 5, 7, 0, 9, 12, 14, 16, 18],
      no: [1, 3, 5, 7, 0, 9, 12, 14, 16, 2],
    },
    {
      key: 'NINE_OF_TEN',
      color: 1,
      number: 0,
      yes: [2, 4, 6, 8, 0, 10, 11, 13, 15, 17],
      no: [2, 4, 6, 8, 0, 10, 11, 13, 15, 1],
    },
  ];
  for (const c of cases)
    for (const won of [true, false]) {
      it(`pays exactly once and releases reserves: ${c.key}/${c.color}/${c.number} ${won ? 'win' : 'loss'}`, async () => {
        const { sideBet, player, token, engine } = await loadFixture(fixture);
        const offer = X100_OFFERS.find((x) => x.key === c.key)!;
        const entry = buildX100CatalogueForMarket(1).find(
          (x) => x.betType === offer.betType && x.color === c.color && x.targetNumber === c.number,
        )!;
        await sideBet.write.addConfig([toConfigStruct(entry)]);
        await sideBet.write.setConfigStakeLimits([0n, units('1'), units('10')]);
        const before = await token.read.balanceOf([player.account.address]);
        const stake = units('1') + 1n; // also exercises token-unit rounding
        await sideBet.write.placeBet([0n, stake], { account: player.account });
        const payout = (stake * BigInt(entry.multiplierBps)) / 10000n;
        expect(await sideBet.read.reservedOf([1])).eq(payout);
        // One short of the decisive prefix remains unsettled.
        const numbers = won ? c.yes : c.no;
        await engine.write.fulfillRounds([numbers.slice(0, -1)]);
        expect(await sideBet.read.isResolvable([0n])).eq(false);
        await engine.write.fulfillRound([numbers[numbers.length - 1]]);
        const [rows, , effects] = await sideBet.read.previewSettleBundleV2([0n, 1, 0, 1]);
        expect(rows).length(1);
        expect(rows[0].won).eq(won);
        await sideBet.write.settleBatchV2([rows, effects]);
        expect(await token.read.balanceOf([player.account.address])).eq(before - stake + (won ? payout : 0n));
        expect(await sideBet.read.reservedOf([1])).eq(0n);
        await sideBet.write.settleBatchV2([rows, effects]);
        expect(await token.read.balanceOf([player.account.address])).eq(before - stake + (won ? payout : 0n));
      });
    }

  it('backs the maximum stake for the largest multiplier', async () => {
    const { sideBet, token, player, vault } = await loadFixture(fixture);
    const entry = buildX100CatalogueForMarket(1).find((x) => x.betType === 0)!;
    const max = computeMaxStake(await sideBet.read.availableVaultLiquidity([1]), entry.multiplierBps);
    await token.write.mint([player.account.address, max]);
    await token.write.approve([vault.address, max], { account: player.account });
    await sideBet.write.addConfig([toConfigStruct(entry)]);
    await sideBet.write.setConfigStakeLimits([0n, 1n, max]);
    await sideBet.write.placeBet([0n, max], { account: player.account });
  });
});
