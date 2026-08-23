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
 * The withdrawal queue's only drain is `processWithdrawalQueue`, reachable solely from
 * `_finalizeMarketSettlement` — which the engine only reaches for a market that had bets in the
 * round. A market with no betting activity therefore never drains, and a queued LP cannot re-request
 * because `_assertCanEnqueue` reverts while one is pending. Their funds are stuck indefinitely.
 */
async function deployQuietMarket() {
    const [admin, alice] = await viem.getWalletClients();
    const { engine, registry } = await deployProtocolStack();

    const usdc = await viem.deployContract("MockUSDC");
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

    await usdc.write.mint([alice.account.address, USDC("1000")]);
    await usdc.write.approve([bank.address, USDC("1000")], { account: alice.account });
    await bank.write.deposit([USDC("500"), alice.account.address], { account: alice.account });

    return { admin, alice, engine, usdc, bank };
}

describe("Stuck withdrawal queue escape hatch (H-1)", function () {
    it("lets an LP exit a market that never sees a bet", async function () {
        const { alice, usdc, bank } = await deployQuietMarket();

        await bank.write.redeemBps([10_000, alice.account.address, alice.account.address], {
            account: alice.account,
        });

        // No bets are ever placed, so no settlement ever runs and the engine never drains the queue.
        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await bank.write.drainWithdrawalQueue([5n], { account: alice.account });

        expect(await usdc.read.balanceOf([alice.account.address])).to.be.gt(balanceBefore);
        expect(await bank.read.balanceOf([alice.account.address])).to.equal(0n);
    });

    it("is callable by anyone, not just the queued owner", async function () {
        const [, , stranger] = await viem.getWalletClients();
        const { alice, usdc, bank } = await deployQuietMarket();

        await bank.write.redeemBps([10_000, alice.account.address, alice.account.address], {
            account: alice.account,
        });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await bank.write.drainWithdrawalQueue([5n], { account: stranger.account });
        expect(await usdc.read.balanceOf([alice.account.address])).to.be.gt(balanceBefore);
    });

    it("refuses to drain while the round is resolving, so LPs cannot exit ahead of winners", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const publicClient = await viem.getPublicClient();
        const { engine, registry, scheduler, vrf } = await deployProtocolStack();
        await wireTestSchedulerForwarder(scheduler, admin.account);

        const usdc = await viem.deployContract("MockUSDC");
        const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

        await usdc.write.mint([admin.account.address, USDC("5000")]);
        await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
        await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });

        await bank.write.redeemBps([5_000, bob.account.address, admin.account.address], {
            account: admin.account,
        });

        await usdc.write.mint([alice.account.address, USDC("100")]);
        await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });
        await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
            account: alice.account,
        });

        // Drive the round to Settling: VRF requested, then fulfilled, payouts not yet applied.
        await time.increase(550);
        const roundId = await engine.read.currentGlobalRound();
        await runParallelLanesUntilVrfPending(engine, scheduler);
        await fulfillVrfForGlobalRound(publicClient, vrf, engine, roundId, 7n);

        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);

        // releaseBets zeroes lockedBetLiquidity before winners are paid, so an open hatch here would
        // let LPs walk out with money the round still owes.
        await expect(bank.write.drainWithdrawalQueue([5n], { account: bob.account })).to.be.rejected;
    });

    it("refuses to burn shares when the vault has no free assets", async function () {
        const [admin, alice, sideBetOperator] = await viem.getWalletClients();
        const { registry } = await deployProtocolStack();

        const usdc = await viem.deployContract("MockUSDC");
        const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
        await bank.write.setSideBetController([sideBetOperator.account.address], { account: admin.account });

        await usdc.write.mint([alice.account.address, USDC("500")]);
        await usdc.write.approve([bank.address, USDC("500")], { account: alice.account });
        await bank.write.deposit([USDC("500"), alice.account.address], { account: alice.account });

        await bank.write.redeemBps([10_000, alice.account.address, alice.account.address], {
            account: alice.account,
        });

        // Lock the entire vault behind a side-bet reserve: NAV is now zero, so processing would burn
        // Alice's shares and pay her nothing.
        await usdc.write.mint([sideBetOperator.account.address, USDC("10")]);
        await usdc.write.approve([bank.address, USDC("10")], { account: sideBetOperator.account });
        await bank.write.lockSideBetStake([sideBetOperator.account.address, USDC("10"), USDC("510")], {
            account: sideBetOperator.account,
        });
        expect(await bank.read.totalAssets()).to.equal(0n);

        await expect(bank.write.drainWithdrawalQueue([5n], { account: alice.account })).to.be.rejected;
        expect(await bank.read.balanceOf([alice.account.address])).to.be.gt(0n);
    });
});
