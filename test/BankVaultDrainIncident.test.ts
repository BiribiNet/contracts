import { ethers, viem } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { maxUint256, zeroAddress } from "viem";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { createMarketWithBeacon } from "./helpers/createMarket";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";
import { customErrorPattern } from "./helpers/customErrorPattern";

async function fixture(decimals: 6 | 18) {
    const [admin, alice, bob, stranger] = await viem.getWalletClients();
    const stack = await deployProtocolStack({ maxPayoutsPerCall: 1 });
    await stack.sideBet.write.setSideBetsDisabled([true]);
    const token = await viem.deployContract(decimals === 6 ? "MockUSDC" : "MockDAI");
    const unit = 10n ** BigInt(decimals);
    const bank = await createMarketWithBeacon(stack.registry, admin.account.address, token.address, unit);
    for (const who of [admin, alice, bob]) {
        await token.write.mint([who.account.address, 10_000n * unit]);
        await token.write.approve([bank.address, maxUint256], { account: who.account });
    }
    await bank.write.deposit([1000n * unit, admin.account.address]);
    await bank.write.deposit([100n * unit, alice.account.address], { account: alice.account });
    return { ...stack, admin, alice, bob, stranger, bank, token, unit };
}

describe("Deployed drainWithdrawalQueue guards with side bets disabled", function () {
    for (const decimals of [6, 18] as const) {
        it(`blocks an open straight-bet drain and all VRF/partial-payout windows (${decimals} decimals)`, async function () {
            const s = await fixture(decimals);
            const nav = await s.bank.read.totalAssets(), quote = await s.bank.read.previewDeposit([2n * s.unit]);
            for (const who of [s.alice, s.bob]) await s.bank.write.placeBet([
                10n * s.unit, encodeSingleBet(1n, 7n, 10n * s.unit), zeroAddress], { account: who.account });
            expect(await s.bank.read.totalAssets()).to.equal(nav);
            expect(await s.bank.read.previewDeposit([2n * s.unit])).to.equal(quote);
            expect(await s.engine.read.marketRouletteLiquidityNeed([1])).to.be.gt(0n);
            await s.bank.write.redeemBps([10_000, s.alice.account.address, s.alice.account.address], { account: s.alice.account });
            const shares = await s.bank.read.balanceOf([s.alice.account.address]);
            const balance = await s.token.read.balanceOf([s.bank.address]);
            const rejectDrain = async () => {
                await expect(s.bank.write.drainWithdrawalQueue([10n], { account: s.stranger.account }))
                    .to.be.rejectedWith(customErrorPattern("WithdrawalBlockedDuringResolution()"));
                expect(await s.bank.read.balanceOf([s.alice.account.address])).to.equal(shares);
            };
            await rejectDrain();
            expect(await s.token.read.balanceOf([s.bank.address])).to.equal(balance);
            await expect(s.bank.write.processWithdrawalQueue([10n], { account: s.stranger.account })).to.be.rejected;
            await time.increase(550);
            await s.scheduler.write.performUpkeep([(await s.scheduler.read.checkUpkeep(["0x"]))[1]]);
            expect(await s.engine.read.hasPendingVrf()).to.equal(true);
            await rejectDrain();
            await s.vrf.write.fulfill([s.engine.address, 1n, 7n]);
            await rejectDrain();
            await s.scheduler.write.performUpkeep([(await s.scheduler.read.checkUpkeep(["0x"]))[1]]);
            expect(await s.bank.read.lockedBetLiquidity()).to.equal(0n);
            expect(await s.engine.read.isBankLiquidityRestricted([1])).to.equal(true);
            await rejectDrain();
            await runParallelLanesUntilIdle(s.scheduler);
            expect(await s.bank.read.balanceOf([s.alice.account.address])).to.equal(0n);
            expect((await s.bank.read.pendingWithdrawalStatus([s.alice.account.address]))[1]).to.equal(false);
        });

        it(`reverts atomic bet -> queued withdrawal -> public drain (${decimals} decimals)`, async function () {
            const s = await fixture(decimals);
            const attempt = await viem.deployContract("RouletteDrainAttempt");
            await s.token.write.approve([attempt.address, maxUint256], { account: s.alice.account });
            await attempt.write.deposit([s.token.address, s.bank.address, 100n * s.unit], { account: s.alice.account });
            const shares = await s.bank.read.balanceOf([attempt.address]);
            const nav = await s.bank.read.totalAssets(), gross = await s.token.read.balanceOf([s.bank.address]);
            await expect(attempt.write.betThenDrain([s.token.address, s.bank.address, 10n * s.unit,
                encodeSingleBet(1n, 7n, 10n * s.unit)], { account: s.alice.account }))
                .to.be.rejectedWith(customErrorPattern("WithdrawalBlockedDuringResolution()"));
            expect(await s.bank.read.balanceOf([attempt.address])).to.equal(shares);
            expect(await s.bank.read.totalAssets()).to.equal(nav);
            expect(await s.bank.read.lockedBetLiquidity()).to.equal(0n);
            expect(await s.token.read.balanceOf([s.bank.address])).to.equal(gross);
            expect((await s.bank.read.pendingWithdrawalStatus([attempt.address]))[1]).to.equal(false);
        });
    }

    it("a public drain pays the queued owner, not the caller; a direct donation raises NAV", async function () {
        const s = await fixture(6);
        const caller = await s.token.read.balanceOf([s.stranger.account.address]);
        const holderBefore = await s.token.read.balanceOf([s.alice.account.address]);
        const nav = await s.bank.read.totalAssets(), quote = await s.bank.read.previewDeposit([2n * s.unit]);
        await s.token.write.transfer([s.bank.address, 10n * s.unit]);
        expect(await s.bank.read.totalAssets()).to.equal(nav + 10n * s.unit);
        expect(await s.bank.read.previewDeposit([2n * s.unit])).to.be.lt(quote);
        const value = await s.bank.read.convertToAssets([await s.bank.read.balanceOf([s.alice.account.address])]);
        await s.bank.write.redeemBps([10_000, s.alice.account.address, s.alice.account.address], { account: s.alice.account });
        await s.bank.write.drainWithdrawalQueue([10n], { account: s.stranger.account });
        expect(await s.token.read.balanceOf([s.stranger.account.address])).to.equal(caller);
        expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(holderBefore + value - s.unit);
        expect(await s.bank.read.balanceOf([s.alice.account.address])).to.equal(0n);
    });
});
