import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";

async function deploySchedulerStack() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const stack = await deployProtocolStack();
    const { scheduler, engine, registry, brb, router } = stack;

    const usdc = await viem.deployContract("MockUSDC");
    await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

    const authority = await viem.deployContract("CreExecutionAuthority", [admin.account.address]);
    const mockForwarder = await viem.deployContract("MockCreForwarder");
    const receiver = await viem.deployContract("AutomationReceiver", [mockForwarder.address]);
    await authority.write.setExecutorApproved([receiver.address, true], { account: admin.account });
    await scheduler.write.setForwarderAuthority([authority.address], { account: admin.account });

    const lpAmount = parseUnits("50000", 6);
    await usdc.write.mint([admin.account.address, lpAmount]);
    await usdc.write.approve([bank.address, lpAmount], { account: admin.account });
    await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });

    return { admin, alice, bob, engine, scheduler, authority, bank, usdc };
}

describe("Upkeep forwarder gate", function () {
    it("rejects performUpkeep from non-forwarder when forwarder authority is set", async function () {
        const { scheduler, alice, bank, usdc } = await deploySchedulerStack();

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        await time.increase(550);
        const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
        await expect(scheduler.write.performUpkeep([performData], { account: alice.account })).to.be.rejected;
    });
});
