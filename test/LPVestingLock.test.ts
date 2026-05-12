import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("LPVestingLock", function () {
    it("reverts before cliff and releases after 3 years", async function () {
        const [admin, beneficiary] = await viem.getWalletClients();
        const lp = await viem.deployContract("MockUSDC");
        const lock = await viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, admin.account.address]);

        await lp.write.mint([lock.address, parseUnits("100", 6)]);

        await expect(lock.write.release([beneficiary.account.address], { account: beneficiary.account })).to.be.rejected;

        await time.increase(3 * 365 * 24 * 60 * 60 + 1);

        await lock.write.release([beneficiary.account.address], { account: beneficiary.account });
        expect(await lp.read.balanceOf([beneficiary.account.address])).to.equal(parseUnits("100", 6));
        expect(await lp.read.balanceOf([lock.address])).to.equal(0n);
    });

    it("can release a partial LP amount after the cliff", async function () {
        const [admin, beneficiary] = await viem.getWalletClients();
        const lp = await viem.deployContract("MockUSDC");
        const lock = await viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, admin.account.address]);

        await lp.write.mint([lock.address, parseUnits("100", 6)]);
        await time.increase(3 * 365 * 24 * 60 * 60 + 1);

        await lock.write.release([beneficiary.account.address, parseUnits("99", 6)], {
            account: beneficiary.account,
        });
        expect(await lp.read.balanceOf([beneficiary.account.address])).to.equal(parseUnits("99", 6));
        expect(await lp.read.balanceOf([lock.address])).to.equal(parseUnits("1", 6));
    });
});
