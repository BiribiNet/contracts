import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("JackpotTreasury (BRB payBatch)", function () {
    it("pays explicit winner amounts (engine-style remainder on last)", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        await treasury.write.setEngine([alice.account.address], { account: admin.account });

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

    it("covers payBatch revert/edge branches", async function () {
        const [admin] = await viem.getWalletClients();

        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);

        await expect(
            treasury.simulate.payBatch([[admin.account.address], [1n]], { account: admin.account }),
        ).to.be.rejected;

        await treasury.write.setEngine([admin.account.address], { account: admin.account });

        await expect(
            treasury.simulate.payBatch([[admin.account.address], [1n, 2n]], { account: admin.account }),
        ).to.be.rejected;

        const paid0 = await treasury.simulate.payBatch([[admin.account.address], [0n]], { account: admin.account });
        expect(paid0.result).to.equal(0n);
    });
});
