import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { fulfillVrfForGlobalRound, runParallelLanesUntilVrfPending } from "./helpers/parallelUpkeep";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";

const USDC = (amount: string) => parseUnits(amount, 6);

/**
 * Winner rows are authored off-chain by the CRE workflow and handed to `executeJob` verbatim — the
 * engine never recomputes (recipient, amount) from the recorded bets. It does now refuse to hand out
 * more, across the whole round, than the market could legitimately owe.
 */
async function settleUntilPayoutReady() {
    const [admin, alice] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const { engine, registry, scheduler, vrf } = await deployProtocolStack();
    await wireTestSchedulerForwarder(scheduler, admin.account);

    const usdc = await viem.deployContract("MockUSDC");
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

    await usdc.write.mint([admin.account.address, USDC("50000")]);
    await usdc.write.approve([bank.address, USDC("50000")], { account: admin.account });
    await bank.write.deposit([USDC("50000"), admin.account.address], { account: admin.account });

    await usdc.write.mint([alice.account.address, USDC("100")]);
    await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });
    await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
        account: alice.account,
    });

    await time.increase(550);
    const roundId = await engine.read.currentGlobalRound();
    await runParallelLanesUntilVrfPending(engine, scheduler);
    await fulfillVrfForGlobalRound(publicClient, vrf, engine, roundId, 7n);

    // executeJob is scheduler-only; the scheduler is a contract, so drive it as an impersonated EOA.
    const testClient = await viem.getTestClient();
    await testClient.impersonateAccount({ address: scheduler.address });
    await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });

    return { admin, alice, engine, scheduler: scheduler.address, usdc, bank, roundId };
}

describe("Payout rows are bounded by the round's own liability", function () {
    it("applies honest preview rows unchanged", async function () {
        const { alice, engine, scheduler, usdc } = await settleUntilPayoutReady();

        const job = {
            kind: 2,
            marketId: 1,
            roundId: 1n,
            nextCursor: 0,
            payoutShardIndex: 0,
            payoutShardWidth: 1,
        };
        const [rows, jackpotWinners, jackpotAmounts] = await engine.read.previewPayoutBundle([job, 10]);
        expect(rows.length).to.be.gt(0);

        const before = await usdc.read.balanceOf([alice.account.address]);
        await engine.write.executeJob([job, rows, jackpotWinners, jackpotAmounts], {
            account: scheduler,
        });

        // The straight bet on 7 hit: the winner is paid, exactly as the preview said.
        expect(await usdc.read.balanceOf([alice.account.address])).to.be.gt(before);
    });

    it("rejects a report that inflates a winner's amount beyond the round's max liability", async function () {
        const { alice, engine, scheduler, usdc, bank } = await settleUntilPayoutReady();

        const job = {
            kind: 2,
            marketId: 1,
            roundId: 1n,
            nextCursor: 0,
            payoutShardIndex: 0,
            payoutShardWidth: 1,
        };
        const [rows] = await engine.read.previewPayoutBundle([job, 10]);
        expect(rows.length).to.be.gt(0);

        // The vault is deep enough to settle this transfer, so nothing else would stop it: the row
        // amount is simply not what the recorded bet won.
        const looted = rows.map((row) => ({ player: row.player, amount: USDC("40000") }));
        expect(await usdc.read.balanceOf([bank.address])).to.be.gt(USDC("40000"));

        const vaultBefore = await usdc.read.balanceOf([bank.address]);
        const aliceBefore = await usdc.read.balanceOf([alice.account.address]);

        await expect(
            engine.write.executeJob([job, looted, [], []], { account: scheduler }),
        ).to.be.rejectedWith(/PayoutExceedsMarketLiability/);

        expect(await usdc.read.balanceOf([bank.address])).to.equal(vaultBefore);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(aliceBefore);
    });

    it("rejects an extra row that redirects funds to an address that never bet", async function () {
        const { engine, scheduler } = await settleUntilPayoutReady();
        const [, , stranger] = await viem.getWalletClients();

        const job = {
            kind: 2,
            marketId: 1,
            roundId: 1n,
            nextCursor: 0,
            payoutShardIndex: 0,
            payoutShardWidth: 1,
        };
        const [rows] = await engine.read.previewPayoutBundle([job, 10]);

        // Padding the batch with a stranger row pushes the round's total past its ceiling. Within
        // the ceiling a bad report could still misdirect — that needs on-chain row recompute, which
        // is deliberately not paid for here; this bounds the damage, it does not eliminate it.
        const padded = [...rows, { player: stranger.account.address, amount: USDC("40000") }];

        await expect(
            engine.write.executeJob([job, padded, [], []], { account: scheduler }),
        ).to.be.rejectedWith(/PayoutExceedsMarketLiability/);
    });
});
