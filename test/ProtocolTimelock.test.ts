import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeFunctionData } from "viem";

describe("ProtocolTimelock", function () {
    it("reverts on zero constructor addresses", async function () {
        const [admin, proposer, executor] = await viem.getWalletClients();
        await expect(
            viem.deployContract("ProtocolTimelock", [
                "0x0000000000000000000000000000000000000000",
                proposer.account.address,
                executor.account.address,
            ]),
        ).to.be.rejected;
    });

    it("queues, waits 24h, then executes; rejects early execute and double-queue", async function () {
        const [admin, proposer, executor, other] = await viem.getWalletClients();
        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);

        const callee = await viem.deployContract("MockTimelockCallee");
        const salt = 0n;
        const data = encodeFunctionData({
            abi: callee.abi,
            functionName: "setX",
            args: [99n],
        });

        await expect(
            timelock.write.queue([callee.address, 0n, data, salt], { account: other.account }),
        ).to.be.rejected;

        await timelock.write.queue([callee.address, 0n, data, salt], { account: proposer.account });

        await expect(
            timelock.write.execute([callee.address, 0n, data, salt], { account: executor.account, value: 0n }),
        ).to.be.rejected;

        await expect(
            timelock.write.queue([callee.address, 0n, data, salt], { account: proposer.account }),
        ).to.be.rejected;

        await time.increase(24 * 3600 + 1);

        await timelock.write.execute([callee.address, 0n, data, salt], { account: executor.account, value: 0n });
        expect(await callee.read.x()).to.equal(99n);
    });

    it("execute forwards native value from msg.value (no pre-deposit)", async function () {
        const [admin, proposer, executor] = await viem.getWalletClients();
        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);
        const callee = await viem.deployContract("MockTimelockCallee");
        const salt = 2n;
        const value = 1n;

        await timelock.write.queue([callee.address, value, "0x", salt], { account: proposer.account });
        await time.increase(24 * 3600 + 1);

        await timelock.write.execute([callee.address, value, "0x", salt], {
            account: executor.account,
            value,
        });
        expect(await callee.read.lastReceived()).to.equal(value);
    });

    it("admin can cancel a queued operation", async function () {
        const [admin, proposer, executor] = await viem.getWalletClients();
        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);
        const callee = await viem.deployContract("MockTimelockCallee");
        const salt = 1n;
        const data = encodeFunctionData({
            abi: callee.abi,
            functionName: "setX",
            args: [7n],
        });

        await timelock.write.queue([callee.address, 0n, data, salt], { account: proposer.account });
        const id = await timelock.read.operationId([callee.address, 0n, data, salt]);
        await timelock.write.cancel([id], { account: admin.account });

        await time.increase(24 * 3600 + 1);
        await expect(
            timelock.write.execute([callee.address, 0n, data, salt], { account: executor.account, value: 0n }),
        ).to.be.rejected;
        expect(await callee.read.x()).to.equal(0n);
    });

    it("reverts cancel and execute on unknown operations", async function () {
        const [admin, proposer, executor] = await viem.getWalletClients();
        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);
        const unknownId = "0x" + "ab".repeat(32);

        await expect(timelock.write.cancel([unknownId], { account: admin.account })).to.be.rejected;

        const callee = await viem.deployContract("MockTimelockCallee");
        await expect(
            timelock.write.execute([callee.address, 0n, "0x", 99n], { account: executor.account, value: 0n }),
        ).to.be.rejected;
    });
});
