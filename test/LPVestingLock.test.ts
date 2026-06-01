import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseUnits } from "viem";

describe("LPVestingLock", function () {
    it("reverts on zero constructor addresses", async function () {
        const [admin, beneficiary] = await viem.getWalletClients();
        const lp = await viem.deployContract("MockUSDC");

        await expect(
            viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, "0x0000000000000000000000000000000000000000"]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("LPVestingLock", [lp.address, "0x0000000000000000000000000000000000000000", admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("LPVestingLock", ["0x0000000000000000000000000000000000000000", beneficiary.account.address, admin.account.address]),
        ).to.be.rejected;
    });

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

    it("reverts partial release with invalid args", async function () {
        const [admin, beneficiary] = await viem.getWalletClients();
        const lp = await viem.deployContract("MockUSDC");
        const lock = await viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, admin.account.address]);

        await lp.write.mint([lock.address, parseUnits("100", 6)]);

        await expect(
            lock.write.release([beneficiary.account.address, parseUnits("1", 6)], { account: beneficiary.account }),
        ).to.be.rejected;

        await time.increase(3 * 365 * 24 * 60 * 60 + 1);

        await expect(
            lock.write.release(["0x0000000000000000000000000000000000000000", parseUnits("1", 6)], {
                account: beneficiary.account,
            }),
        ).to.be.rejected;
        await expect(
            lock.write.release([beneficiary.account.address, 0n], { account: beneficiary.account }),
        ).to.be.rejected;
        await expect(
            lock.write.release([beneficiary.account.address, parseUnits("101", 6)], { account: beneficiary.account }),
        ).to.be.rejected;
    });
});
