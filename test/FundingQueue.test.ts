import { viem } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { parseUnits, zeroAddress } from 'viem';

async function fixture() {
  const [admin, keeper] = await viem.getWalletClients();
  const brb = await viem.deployContract('BRBToken', [admin.account.address]);
  const router = await viem.deployContract('MockUniswapV2Router');
  const factory = await viem.deployContract('MockUniswapV2Factory');
  await router.write.setFactory([factory.address]);
  const funder = await viem.deployContract('BRBJackpotFunder', [admin.account.address, brb.address,
    router.address, keeper.account.address, admin.account.address, admin.account.address]);
  const usdc = await viem.deployContract('MockUSDC');
  const pair = await viem.deployContract('MockUniswapV2Pair', [usdc.address, brb.address]);
  await factory.write.setPair([usdc.address, brb.address, pair.address]);
  const reserves = usdc.address.toLowerCase() < brb.address.toLowerCase()
    ? [parseUnits('10000', 6), parseUnits('10000', 18)] : [parseUnits('10000', 18), parseUnits('10000', 6)];
  await pair.write.setReserves(reserves);
  await brb.write.transfer([router.address, parseUnits('100000', 18)]);
  return { admin, keeper, brb, usdc, funder, router, pair };
}

describe('Funding queue and reconciliation', function () {
  it('isolates two vaults sharing one token, including an older failed swap', async function () {
    const f = await fixture();
    await f.usdc.write.mint([f.funder.address, parseUnits('150', 6)]);
    await f.funder.write.queueFunding([1, f.usdc.address, parseUnits('100', 6)]);
    await f.funder.write.queueFunding([2, f.usdc.address, parseUnits('50', 6)]);
    await f.router.write.setForceRevertSwap([true]);
    await f.funder.write.processFunding([1], { account: f.keeper.account });
    await f.router.write.setForceRevertSwap([false]);
    await f.funder.write.processFunding([2], { account: f.keeper.account });
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(parseUnits('100', 6));
    expect((await f.funder.read.fundingAccounts([2]))[3]).to.equal(parseUnits('50', 6));
    expect(await f.usdc.read.balanceOf([f.funder.address])).to.equal(parseUnits('100', 6));
    await expect(f.funder.write.sweepToken([f.usdc.address, f.admin.account.address, 0n])).to.be.rejected;
  });

  it('queues without touching a broken router; only the worker attempts a swap', async function () {
    const f = await fixture();
    await f.router.write.setForceRevertGetAmountsOut([true]);
    await f.usdc.write.mint([f.funder.address, 10n]);
    await f.funder.write.queueFunding([1, f.usdc.address, 10n]);
    expect(await f.funder.read.fundingAttemptCount()).to.equal(0n);
    expect(await f.usdc.read.allowance([f.funder.address, f.router.address])).to.equal(0n);
    await expect(f.funder.write.queueFunding([1, f.brb.address, 1n])).to.be.rejected;
    await expect(f.funder.write.fundFromMarket([1, f.brb.address])).to.be.rejected;
    await expect(f.funder.write.queueFunding([1, f.usdc.address, 1n], { account: f.keeper.account })).to.be.rejected;
    await expect(f.funder.write.executeFunding([1])).to.be.rejected;
    await expect(f.funder.write.queueFunding([1, zeroAddress, 1n])).to.be.rejected;
  });

  it('imports only unassigned backed funds and never double credits a migration', async function () {
    const f = await fixture();
    const receipt = ('0x' + '12'.repeat(32)) as `0x${string}`;
    await f.usdc.write.mint([f.funder.address, 100n]);
    await f.funder.write.importFunding([1, f.usdc.address, 100n, receipt]);
    await expect(f.funder.write.importFunding([2, f.usdc.address, 1n, receipt])).to.be.rejected;
    await expect(f.funder.write.importFunding([1, f.usdc.address, 1n, receipt], { account: f.keeper.account })).to.be.rejected;
    expect((await f.funder.read.fundingAccounts([1]))[2]).to.equal(100n);
  });

  it('splits accumulated input at one percent of reserves and preserves the remainder', async function () {
    const f = await fixture();
    await f.usdc.write.mint([f.funder.address, parseUnits('250', 6)]);
    await f.funder.write.queueFunding([1, f.usdc.address, parseUnits('250', 6)]);
    await f.funder.write.processFunding([1]);
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(parseUnits('150', 6));
    await f.funder.write.processFunding([1]); // cooldown prevents another chunk
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(parseUnits('150', 6));
    await time.increase(60);
    await f.funder.write.processFunding([1]);
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(parseUnits('50', 6));
    await time.increase(60);
    await f.funder.write.processFunding([1]);
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(0n);
    expect(await f.usdc.read.allowance([f.funder.address, f.router.address])).to.equal(0n);
    await expect(f.funder.write.setMaxSwapReserveBps([501n])).to.be.rejected;
  });

  it('stops after five failures, retains every asset, and requires an admin reset', async function () {
    const f = await fixture();
    await f.usdc.write.mint([f.funder.address, parseUnits('10', 6)]);
    await f.funder.write.queueFunding([1, f.usdc.address, parseUnits('10', 6)]);
    await f.router.write.setForceRevertSwap([true]);
    for (let i = 0; i < 7; i++) { await f.funder.write.processFunding([1]); await time.increase(60); }
    expect(await f.funder.read.fundingAttemptCount()).to.equal(5n);
    expect(await f.funder.read.consecutiveFailures([1])).to.equal(5);
    await expect(f.funder.write.resetFundingRetry([1], { account: f.keeper.account })).to.be.rejected;
    await f.funder.write.resetFundingRetry([1]);
    await f.router.write.setForceRevertSwap([false]);
    await f.funder.write.processFunding([1]);
    expect((await f.funder.read.fundingAccounts([1]))[1]).to.equal(0n);
    await expect(f.funder.write.processFundingBatch([Array.from({ length: 11 }, () => 1)])).to.be.rejected;
  });

  it('maintains an oracle anchor without executing a swap', async function () {
    const f = await fixture();
    await f.funder.write.updateObservation([f.usdc.address]);
    const first = (await f.funder.read.pairObservations([f.pair.address]))[0];
    await time.increase(600);
    await f.funder.write.updateObservation([f.usdc.address]);
    await time.increase(1800);
    await f.funder.write.updateObservation([f.usdc.address]);
    expect((await f.funder.read.pairObservations([f.pair.address]))[0]).to.be.gt(first);
    expect(await f.funder.read.fundingAttemptCount()).to.equal(0n);
  });

  it('does not consume retries when a caller supplies insufficient gas', async function () {
    const f = await fixture();
    await f.usdc.write.mint([f.funder.address, 100n]);
    await f.funder.write.queueFunding([1, f.usdc.address, 100n]);
    await expect(f.funder.write.processFunding([1], { gas: 300000n })).to.be.rejected;
    expect(await f.funder.read.fundingAttemptCount()).to.equal(0n);
    expect(await f.funder.read.consecutiveFailures([1])).to.equal(0);
  });

  it('isolates approval failures inside the worker, retaining the credited input', async function () {
    const f = await fixture();
    const token = await viem.deployContract('MockApprovalFailure');
    const factory = await viem.getContractAt('MockUniswapV2Factory', await f.router.read.factory());
    const pair = await viem.deployContract('MockUniswapV2Pair', [token.address, f.brb.address]);
    await factory.write.setPair([token.address, f.brb.address, pair.address]);
    await pair.write.setReserves([10n ** 20n, 10n ** 20n]);
    await token.write.mint([f.funder.address, 100n]);
    await f.funder.write.queueFunding([3, token.address, 100n]);
    await f.funder.write.processFunding([3], { gas: 1000000n });
    expect((await f.funder.read.fundingAccounts([3]))[1]).to.equal(100n);
    expect(await token.read.balanceOf([f.funder.address])).to.equal(100n);
    expect(await f.funder.read.consecutiveFailures([3])).to.equal(1);
  });

  it('retries BRB debts automatically without assigning them to another vault or changing their split', async function () {
    const f = await fixture();
    const token = await viem.deployContract('MockBRBWithFeeHooks', [f.admin.account.address]);
    const funder = await viem.deployContract('BRBJackpotFunder', [f.admin.account.address, token.address,
      f.router.address, f.keeper.account.address, f.admin.account.address, f.admin.account.address]);
    await token.write.transfer([funder.address, 300n]);
    await funder.write.queueFunding([1, token.address, 300n]);
    await token.write.setFailBurn([true]);
    await token.write.setFailTransfer([true]);
    await funder.write.processFunding([1], { gas: 1000000n });
    expect(await funder.read.pendingBrbByMarket([1])).to.deep.equal([250n, 50n]);
    await funder.write.setTreasuryBrbSplit([0n, 300n]);
    await token.write.setFailBurn([false]); await token.write.setFailTransfer([false]);
    await token.write.transfer([funder.address, 30n]);
    await funder.write.queueFunding([2, token.address, 30n]);
    await funder.write.processFunding([2], { gas: 1000000n });
    expect(await funder.read.pendingBrbByMarket([1])).to.deep.equal([250n, 50n]);
    await time.increase(60);
    await funder.write.processFunding([1], { gas: 1000000n });
    const a = await funder.read.fundingAccounts([1]);
    expect(a[4]).to.equal(a[5] + a[6]);
    expect(a[5]).to.equal(250n);
    expect(await funder.read.pendingBrbByMarket([1])).to.deep.equal([0n, 0n]);
    const after = await token.read.balanceOf([f.keeper.account.address]);
    await time.increase(60); await funder.write.processFunding([1], { gas: 1000000n });
    expect(await token.read.balanceOf([f.keeper.account.address])).to.equal(after);
  });

  for (const seedValue of [17, 9127, 60109]) {
    it(`conserves two vault ledgers through seeded deposits, failures and split changes (${seedValue})`, async function () {
      const f = await fixture();
      let seed = seedValue;
      for (let step = 0; step < 24; step++) {
        seed = (seed * 16807) % 2147483647;
        const market = seed % 2 + 1;
        const amount = BigInt(seed % 100000 + 1);
        await f.usdc.write.mint([f.funder.address, amount]);
        await f.funder.write.queueFunding([market, f.usdc.address, amount]);
        await f.funder.write.setTreasuryBrbSplit([BigInt(seed % 301), 300n]);
        await f.router.write.setForceRevertSwap([step % 4 === 0]);
        await f.funder.write.processFundingBatch([[2, 1]]);
        await time.increase(60);
        let queued = 0n;
        for (const id of [1, 2]) {
          const a = await f.funder.read.fundingAccounts([id]);
          const debt = await f.funder.read.pendingBrbByMarket([id]);
          expect(a[2]).to.equal(a[1] + a[3]);
          expect(a[4]).to.equal(a[5] + a[6] + debt[0] + debt[1]);
          queued += a[1];
        }
        expect(await f.usdc.read.balanceOf([f.funder.address])).to.equal(queued);
        expect(await f.funder.read.queuedAssetTotals([f.usdc.address])).to.equal(queued);
      }
    });
  }
});
