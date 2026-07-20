import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, encodeFunctionData, parseUnits, toFunctionSelector, zeroAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";

const PERFORM_UPKEEP_SELECTOR = toFunctionSelector("performUpkeep(bytes)");

async function deployBridgeStack() {
    const [admin, alice] = await viem.getWalletClients();
    const stack = await deployProtocolStack();
    const { scheduler, engine, registry, brb, router } = stack;

    const usdc = await viem.deployContract("MockUSDC");
    await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

    const mockForwarder = await viem.deployContract("MockCreForwarder");
    const receiver = await viem.deployContract("AutomationReceiver", [mockForwarder.address]);
    const authority = await viem.deployContract("CreExecutionAuthority", [admin.account.address]);

    await authority.write.setExecutorApproved([receiver.address, true], { account: admin.account });
    await scheduler.write.setForwarderAuthority([authority.address], { account: admin.account });
    await receiver.write.setCallAllowed([scheduler.address, PERFORM_UPKEEP_SELECTOR, true], {
        account: admin.account,
    });

    const lpAmount = parseUnits("50000", 6);
    await usdc.write.mint([admin.account.address, lpAmount]);
    await usdc.write.approve([bank.address, lpAmount], { account: admin.account });
    await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });

    return { admin, alice, engine, scheduler, receiver, authority, mockForwarder, bank, usdc };
}

function buildPerformUpkeepReport(scheduler: `0x${string}`, performData: `0x${string}`) {
    const callData = encodeFunctionData({
        abi: [{ type: "function", name: "performUpkeep", inputs: [{ type: "bytes", name: "performData" }] }],
        functionName: "performUpkeep",
        args: [performData],
    });
    return encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }],
        [scheduler, callData],
    );
}

describe("AutomationReceiver bridge", function () {
    it("forwards performUpkeep to scheduler when authority approves receiver", async function () {
        const { admin, alice, scheduler, receiver, mockForwarder, bank, usdc } = await deployBridgeStack();

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        await time.increase(550);
        const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
        const report = buildPerformUpkeepReport(scheduler.address, performData);

        await mockForwarder.write.deliverReport([receiver.address, report]);

        const publicClient = await viem.getPublicClient();
        const events = await publicClient.getContractEvents({
            address: receiver.address,
            abi: receiver.abi,
            eventName: "CallExecuted",
            strict: true,
        });
        expect(events.length).to.equal(1);
        expect(events[0].args.target?.toLowerCase()).to.equal(scheduler.address.toLowerCase());
    });

    it("rejects direct performUpkeep from non-approved caller", async function () {
        const { alice, scheduler, bank, usdc } = await deployBridgeStack();

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        await time.increase(550);
        const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
        await expect(scheduler.write.performUpkeep([performData], { account: alice.account })).to.be.rejected;
    });

    it("reverts when performUpkeep selector is not allowlisted on receiver", async function () {
        const { admin, alice, scheduler, receiver, mockForwarder, bank, usdc } = await deployBridgeStack();

        await receiver.write.setCallAllowed([scheduler.address, PERFORM_UPKEEP_SELECTOR, false], {
            account: admin.account,
        });

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        await time.increase(550);
        const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
        const report = buildPerformUpkeepReport(scheduler.address, performData);

        await expect(mockForwarder.write.deliverReport([receiver.address, report])).to.be.rejected;
    });
});
