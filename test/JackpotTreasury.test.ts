import { viem } from "hardhat";

import { expect } from "chai";
import { parseUnits } from "viem";

describe("JackpotTreasury (BRB payBatch)", function () {
    it("pays explicit winner amounts (engine-style remainder on last)", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            alice.account.address,
            admin.account.address,
        ]);

        const pool = parseUnits("1000", 18);
        await brb.write.transfer([treasury.address, pool], { account: admin.account });

        const total = 40n;
        const amtAlice = (pool * 10n) / total;
        const amtBob = pool - amtAlice;

        await treasury.write.payBatch(
            [[alice.account.address, bob.account.address], [amtAlice, amtBob]],
            { account: alice.account },
        );

        expect(await brb.read.balanceOf([treasury.address])).to.equal(0n);
        expect(await brb.read.balanceOf([alice.account.address])).to.equal(amtAlice);
        expect(await brb.read.balanceOf([bob.account.address])).to.equal(amtBob);
    });

    it("caps each row at the remaining pool instead of reverting the batch (C-3)", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            alice.account.address,
            admin.account.address,
        ]);

        const pool = parseUnits("100", 18);
        await brb.write.transfer([treasury.address, pool], { account: admin.account });

        // Amounts the treasury did not compute itself, summing to well over the pool. It must pay out
        // at most what it holds rather than transferring against a balance it does not have (which
        // would revert the whole batch and stall settlement).
        const oversized = parseUnits("400", 18);
        await treasury.write.payBatch(
            [[alice.account.address, bob.account.address], [oversized, oversized]],
            { account: alice.account },
        );

        expect(await brb.read.balanceOf([treasury.address])).to.equal(0n);
        expect(await brb.read.balanceOf([alice.account.address])).to.equal(pool);
        expect(await brb.read.balanceOf([bob.account.address])).to.equal(0n);
    });

    it("covers payBatch revert/edge branches", async function () {
        const [admin] = await viem.getWalletClients();

        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);

        await expect(
            treasury.simulate.payBatch([[admin.account.address], [1n, 2n]], { account: admin.account }),
        ).to.be.rejected;

        const paid0 = await treasury.simulate.payBatch([[admin.account.address], [0n]], { account: admin.account });
        expect(paid0.result).to.equal(0n);
    });

    it("reverts constructor when engine is zero", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        await expect(
            viem.deployContract("JackpotTreasury", [
                brb.address,
                "0x0000000000000000000000000000000000000000",
                admin.account.address,
            ]),
        ).to.be.rejected;
    });
});
