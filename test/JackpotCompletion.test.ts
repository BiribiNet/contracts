import { viem } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { expect } from 'chai';
import { parseUnits, zeroAddress } from 'viem';
import { deployProtocolStack } from './helpers/deployProtocolStack';
import { createMarketWithBeacon } from './helpers/createMarket';
import { encodeSingleBet } from './helpers/multiBetEncode';
import { runParallelLanesUntilIdle, runParallelLanesUntilVrfPending } from './helpers/parallelUpkeep';

async function fixture(lanes: number) {
  const [admin, alice] = await viem.getWalletClients();
  const stack = await deployProtocolStack({maxPayoutsPerCall: 5});
  await stack.engine.write.setPayoutLaneCount([lanes]);
  const token = await viem.deployContract('MockUSDC');
  const bank = await createMarketWithBeacon(stack.registry, admin.account.address, token.address);
  await token.write.mint([admin.account.address, parseUnits('100000', 6)]);
  await token.write.approve([bank.address, parseUnits('100000', 6)]);
  await bank.write.deposit([parseUnits('100000', 6), admin.account.address]);
  await token.write.mint([alice.account.address, parseUnits('10000', 6)]);
  await token.write.approve([bank.address, parseUnits('10000', 6)], {account: alice.account});
  await stack.brb.write.transfer([stack.treasury.address, parseUnits('1000',18)]);
  return {...stack, admin, alice, token, bank};
}

describe('Jackpot completion across parallel lanes', () => {
  it('rejects a repeated jackpot-only report without changing balances or cursors', async () => {
    const s=await fixture(2);const stake=parseUnits('10',6);
    for(let i=0;i<40;i++) await s.bank.write.placeBet([stake,encodeSingleBet(1n,7n,stake),zeroAddress],{account:s.alice.account});
    await time.increase(550);await runParallelLanesUntilVrfPending(s.engine,s.scheduler,{laneCount:2n});
    const d=await s.engine.read.roundDiagnostics([1n]);
    await s.vrf.write.fulfillWithJackpot([s.engine.address,d.requestId,7n,7n]);
    // Finish lane zero's 20 roulette rows while leaving lane one untouched.
    for(let i=0;i<4;i++){const [needed,data]=await s.scheduler.read.checkUpkeep(['0x']);expect(needed).to.equal(true);await s.scheduler.write.performUpkeep([data]);}
    expect(await s.engine.read.payoutShardCursor([1n,1,0])).to.equal(20n);
    const [needed,data]=await s.scheduler.read.checkUpkeep(['0x']);expect(needed).to.equal(true);
    await s.scheduler.write.performUpkeep([data]);
    const before=await s.brb.read.balanceOf([s.alice.account.address]);
    expect((await s.engine.read.globalRoundState([1n])).jackpotCursor).to.equal(25);
    await expect(s.scheduler.write.performUpkeep([data])).to.be.rejected;
    expect(await s.brb.read.balanceOf([s.alice.account.address])).to.equal(before);
    expect((await s.engine.read.globalRoundState([1n])).jackpotCursor).to.equal(25);
    await runParallelLanesUntilIdle(s.scheduler,{laneCount:2n});
    expect((await s.engine.read.globalRoundState([1n])).jackpotPaid).to.equal(parseUnits('1000',18));
    expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
  });
  for (const lanes of [2,10]) for (const reverseSweep of [false,true]) {
    it(`finishes all jackpot chunks before opening the next round (${lanes} lanes, reverse=${reverseSweep})`, async () => {
      const s = await fixture(lanes);
      const stake = parseUnits('10',6);
      for (let i=0;i<40;i++) await s.bank.write.placeBet([stake,encodeSingleBet(1n,7n,stake),zeroAddress],{account:s.alice.account});
      await time.increase(550);
      await runParallelLanesUntilVrfPending(s.engine,s.scheduler,{laneCount:BigInt(lanes)});
      const d = await s.engine.read.roundDiagnostics([1n]);
      await s.vrf.write.fulfillWithJackpot([s.engine.address,d.requestId,7n,7n]);
      await runParallelLanesUntilIdle(s.scheduler,{laneCount:BigInt(lanes),reverseSweep});
      const gr = await s.engine.read.globalRoundState([1n]);
      expect(gr.jackpotDistributed).to.equal(true);
      expect(gr.jackpotCursor).to.equal(40);
      expect(gr.jackpotPaid).to.equal(parseUnits('1000',18));
      expect(await s.treasury.read.jackpotPool()).to.equal(0n);
      expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
    });
  }
  it('completes a triggered draw with no eligible straight stake', async () => {
    const s=await fixture(2); const stake=parseUnits('10',6);
    await s.bank.write.placeBet([stake,encodeSingleBet(1n,8n,stake),zeroAddress],{account:s.alice.account});
    await time.increase(550);await runParallelLanesUntilVrfPending(s.engine,s.scheduler,{laneCount:2n});
    const d=await s.engine.read.roundDiagnostics([1n]);
    await s.vrf.write.fulfillWithJackpot([s.engine.address,d.requestId,7n,7n]);
    await runParallelLanesUntilIdle(s.scheduler,{laneCount:2n});
    expect((await s.engine.read.globalRoundState([1n])).jackpotDistributed).to.equal(true);
    expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
    expect(await s.treasury.read.jackpotPool()).to.equal(parseUnits('1000',18));
  });
});
