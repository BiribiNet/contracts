import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("UpkeepManager", function () {
    it("registers lane upkeep and stores forwarder mapping", async function () {
        const [admin] = await viem.getWalletClients();
        const link = await viem.deployContract("MockLinkToken");
        const registrar = await viem.deployContract("MockKeeperRegistry");
        const manager = await viem.deployContract("UpkeepManager", [
            link.address,
            registrar.address,
            registrar.address,
            admin.account.address,
            admin.account.address,
            admin.account.address,
        ]);

        await link.write.approve([manager.address, parseUnits("10", 18)]);
        await manager.write.registerLaneUpkeep([7n, 500_000, parseUnits("1", 18), admin.account.address]);

        const forwarder = await registrar.read.getForwarder([2n]);
        expect(await manager.read.forwarderToUpkeepId([forwarder])).to.equal(2n);
    });

    it("reverts on zero constructor addresses and zero link amount", async function () {
        const [admin] = await viem.getWalletClients();
        const link = await viem.deployContract("MockLinkToken");
        const registrar = await viem.deployContract("MockKeeperRegistry");

        await expect(
            viem.deployContract("UpkeepManager", [
                "0x0000000000000000000000000000000000000000",
                registrar.address,
                registrar.address,
                admin.account.address,
                admin.account.address,
                admin.account.address,
            ]),
        ).to.be.rejected;

        const manager = await viem.deployContract("UpkeepManager", [
            link.address,
            registrar.address,
            registrar.address,
            admin.account.address,
            admin.account.address,
            admin.account.address,
        ]);

        await expect(manager.write.registerLaneUpkeep([1n, 300_000, 0n, admin.account.address])).to.be.rejected;
    });

    it("reverts when registrar returns empty upkeep id", async function () {
        const [admin] = await viem.getWalletClients();
        const link = await viem.deployContract("MockLinkToken");
        const revertingRegistrar = await viem.deployContract("MockKeeperRegistryReverting1");
        const manager = await viem.deployContract("UpkeepManager", [
            link.address,
            revertingRegistrar.address,
            revertingRegistrar.address,
            admin.account.address,
            admin.account.address,
            admin.account.address,
        ]);

        await link.write.approve([manager.address, parseUnits("10", 18)]);
        await expect(
            manager.write.registerLaneUpkeep([1n, 400_000, parseUnits("1", 18), admin.account.address]),
        ).to.be.rejected;
    });
});
