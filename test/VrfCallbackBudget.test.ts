import { network, viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { writeFileSync } from "fs";
import { parseUnits, zeroAddress } from "viem";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeMultiBet } from "./helpers/multiBetEncode";

describe("VRF callback budget at the production ten-lane setting", function () {
    this.timeout(120_000);
    const measurements: object[] = [];
    after(function () {
        writeFileSync("deployments/vrf-callback-budget-2026-10-15.json", JSON.stringify({
            scope: "Local exact engine callback from impersonated configured coordinator; not a live DON delivery or full coordinator billing test",
            gasLimit: 2_500_000, laneCount: 10, measurements,
        }, null, 2) + "\n");
    });
    for (const [marketCount, legsPerMarket] of [[3, 100], [3, 1000]] as const) {
        it(`fulfills within 2.5M gas with ${marketCount} markets and ${legsPerMarket} winning legs in each`, async function () {
            const s = await deployProtocolStack({ roundDuration: 3600 });
            const scheduler = await viem.getContractAt("UpkeepScheduler", s.scheduler.address);
            const vaultImpl = await viem.deployContract("BankVault4626");
            const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, s.admin]);
            await s.registry.write.setVaultBeacon([beacon.address]);
            expect(await s.engine.read.payoutParallelLaneCount()).to.equal(10);
            for (let mid = 1; mid <= marketCount; mid++) {
                const asset = await viem.deployContract("MockUSDC");
                await s.registry.write.createMarket([{ asset: asset.address, bankAdmin: s.admin, minBet: 1_000_000n }]);
                const market = await s.registry.read.getMarket([mid]);
                const bank = await viem.getContractAt("BankVault4626", market.bank);
                await asset.write.mint([s.admin, parseUnits("100000", 6)]);
                await asset.write.approve([bank.address, parseUnits("100000", 6)]);
                await bank.write.deposit([parseUnits("50000", 6), s.admin]);
                for (let done = 0; done < legsPerMarket;) {
                    const count = Math.min(250, legsPerMarket - done);
                    const amount = 1_000_000n;
                    const legs = Array.from({ length: count }, () => ({ betType: 1n, number: 7n, amount }));
                    await bank.write.placeBet([BigInt(count) * amount, encodeMultiBet(legs), zeroAddress], { gas: 25_000_000n });
                    done += count;
                }
            }
            await time.increase(3700);
            const [, data] = await scheduler.read.checkUpkeep(["0x"]);
            await scheduler.write.performUpkeep([data]);
            const coordinator = s.vrf.address;
            await network.provider.send("hardhat_setBalance", [coordinator, "0x1000000000000000000"]);
            await network.provider.send("hardhat_impersonateAccount", [coordinator]);
            try {
                // Enforce a budget on rawFulfillRandomWords itself, unlike the
                // existing helper which lets estimateGas choose the mock wrapper budget.
                const hash = await s.engine.write.rawFulfillRandomWords([1n, [7n, 8n]], { account: coordinator, gas: 2_500_000n });
                const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
                expect(receipt.status).to.equal("success");
                expect(await s.engine.read.hasPendingVrf()).to.equal(false);
                expect((await s.engine.read.roundOutcome([1n]))[1]).to.equal(7);
                // Closed-form shard counts must still match the placed winning straight legs.
                for (let mid = 1; mid <= marketCount; mid++) {
                    const mr = await s.engine.read.marketRoundStateByRound([1n, mid]);
                    expect(mr.winningBetCount).to.equal(BigInt(legsPerMarket));
                }
                const measurement = { marketCount, legsPerMarket, totalWinningLegs: marketCount * legsPerMarket,
                    callbackTransactionGasUsed: receipt.gasUsed.toString(), fixedBudgetSucceeded: true };
                measurements.push(measurement);
                console.log("VRF_CALLBACK_BUDGET", JSON.stringify(measurement));
            } finally {
                await network.provider.send("hardhat_stopImpersonatingAccount", [coordinator]);
            }
        });
    }
});
