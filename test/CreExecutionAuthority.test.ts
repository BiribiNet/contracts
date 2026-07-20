import { viem } from "hardhat";

import { expect } from "chai";
import { zeroAddress } from "viem";

describe("CreExecutionAuthority", function () {
    it("approves and revokes executors", async function () {
        const [admin, receiver] = await viem.getWalletClients();
        const authority = await viem.deployContract("CreExecutionAuthority", [admin.account.address]);

        expect(await authority.read.isApprovedAutomationForwarder([receiver.account.address])).to.equal(false);

        await authority.write.setExecutorApproved([receiver.account.address, true], { account: admin.account });
        expect(await authority.read.isApprovedAutomationForwarder([receiver.account.address])).to.equal(true);

        await authority.write.setExecutorApproved([receiver.account.address, false], { account: admin.account });
        expect(await authority.read.isApprovedAutomationForwarder([receiver.account.address])).to.equal(false);
    });

    it("reverts on zero admin and zero executor", async function () {
        await expect(viem.deployContract("CreExecutionAuthority", [zeroAddress])).to.be.rejected;

        const [admin] = await viem.getWalletClients();
        const authority = await viem.deployContract("CreExecutionAuthority", [admin.account.address]);
        await expect(
            authority.write.setExecutorApproved([zeroAddress, true], { account: admin.account }),
        ).to.be.rejected;
    });

    it("rejects setExecutorApproved from non-admin", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const authority = await viem.deployContract("CreExecutionAuthority", [admin.account.address]);
        await expect(
            authority.write.setExecutorApproved([bob.account.address, true], { account: alice.account }),
        ).to.be.rejected;
    });
});
