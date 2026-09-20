import { artifacts, viem } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { parseUnits, zeroAddress, parseAbi, decodeEventLog } from 'viem';
import { createMarketWithBeacon } from './helpers/createMarket';
import { deployProtocolStack } from './helpers/deployProtocolStack';
import { encodeSingleBet } from './helpers/multiBetEncode';
import { runParallelLanesUntilVrfPending, runParallelLanesUntilIdle } from './helpers/parallelUpkeep';
import { wireTestSchedulerForwarder } from './helpers/wireTestSchedulerForwarder';

describe('Protocol observability', function () {
  it('keeps deployable implementations within EIP-170', async function () {
    for (const name of ['RouletteEngine', 'BankVault4626', 'BRBJackpotFunder', 'SideBet']) {
      const artifact = await artifacts.readArtifact(name);
      expect((artifact.deployedBytecode.length - 2) / 2, name).to.be.lte(24576);
    }
  });
  it('keeps withdrawal IDs after queue resets and records actual net transfers', async function () {
    const [admin, alice] = await viem.getWalletClients();
    const { registry } = await deployProtocolStack();
    const token = await viem.deployContract('MockUSDC');
    const bank = await createMarketWithBeacon(registry, admin.account.address, token.address);
    await token.write.mint([alice.account.address, parseUnits('1000', 6)]);
    await token.write.approve([bank.address, parseUnits('1000', 6)], { account: alice.account });
    for (let id = 1n; id <= 3n; id++) {
      await bank.write.deposit([parseUnits('100', 6), alice.account.address], { account: alice.account });
      await bank.write.redeemBps([10000, alice.account.address, alice.account.address], { account: alice.account });
      expect(await bank.read.pendingWithdrawalStatus([alice.account.address])).to.deep.equal([id, true, 0n]);
      const before = await token.read.balanceOf([alice.account.address]);
      await bank.write.drainWithdrawalQueue([1n]);
      const receipt = await bank.read.withdrawalReceipt([id]);
      expect(receipt.assetsPaid).to.equal((await token.read.balanceOf([alice.account.address])) - before);
      expect(receipt.processedAt).to.be.gte(receipt.requestedAt);
      expect(receipt.sharesBurned).to.be.gt(0n);
      expect(await bank.read.pendingWithdrawalStatus([alice.account.address])).to.deep.equal([0n, false, 0n]);
    }
    expect((await bank.read.withdrawalReceipt([1n])).processedAt).to.be.gt(0n);
  });

  it('retains both VRF numbers, rejects overwrite, and reconciles payment receipts', async function () {
    const [admin, alice] = await viem.getWalletClients();
    const client = await viem.getPublicClient();
    const { registry, engine, scheduler, vrf } = await deployProtocolStack();
    await wireTestSchedulerForwarder(scheduler, admin.account);
    const token = await viem.deployContract('MockUSDC');
    const bank = await createMarketWithBeacon(registry, admin.account.address, token.address);
    await token.write.mint([admin.account.address, parseUnits('5000', 6)]);
    await token.write.approve([bank.address, parseUnits('5000', 6)]);
    await bank.write.deposit([parseUnits('5000', 6), admin.account.address]);
    await token.write.mint([alice.account.address, parseUnits('100', 6)]);
    await token.write.approve([bank.address, parseUnits('100', 6)], { account: alice.account });
    await bank.write.placeBet([parseUnits('10', 6), encodeSingleBet(1n, 7n, parseUnits('10', 6)), zeroAddress], { account: alice.account });
    const round = await engine.read.currentGlobalRound();
    expect((await engine.read.roundDiagnostics([round])).available).to.equal(false);
    await time.increase(550);
    await runParallelLanesUntilVrfPending(engine, scheduler);
    const pending = await engine.read.roundDiagnostics([round]);
    expect(pending.available).to.equal(true);
    expect(pending.requestId).to.be.gt(0n);
    expect(pending.requestedAt).to.be.gt(0n);
    const hash = await vrf.write.fulfillWithJackpot([engine.address, pending.requestId, 7n, 12n]);
    const tx = await client.waitForTransactionReceipt({ hash });
    console.log('VRF diagnostic fixture gas:', tx.gasUsed.toString());
    const outcome = await engine.read.roundDiagnostics([round]);
    expect(outcome.winningNumber).to.equal(7);
    expect(outcome.jackpotNumber).to.equal(12);
    await expect(vrf.write.fulfillWithJackpot([engine.address, pending.requestId, 3n, 3n])).to.be.rejected;
    expect((await engine.read.roundDiagnostics([round])).winningNumber).to.equal(7);
    const before = await token.read.balanceOf([alice.account.address]);
    const fromBlock = await client.getBlockNumber();
    await runParallelLanesUntilIdle(scheduler, { reverseSweep: true });
    const logs = await client.getLogs({ address: engine.address, fromBlock, toBlock: 'latest' });
    const abi = parseAbi(['event RoulettePayment(uint64 indexed roundId, uint32 indexed marketId, address indexed recipient, address token, uint256 amount)']);
    let paid = 0n;
    for (const log of logs) {
      try { const event = decodeEventLog({ abi, data: log.data, topics: log.topics }); paid += event.args.amount; } catch { /* Other engine events */ }
    }
    expect(paid).to.equal(parseUnits('360', 6));
    expect(paid).to.equal((await token.read.balanceOf([alice.account.address])) - before);
    expect((await engine.read.roundDiagnostics([round])).marketsSettled).to.equal(1);
  });
});
