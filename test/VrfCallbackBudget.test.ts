import { network, viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { mkdirSync, writeFileSync } from "fs";
import { encodeFunctionData, parseUnits, zeroAddress } from "viem";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deployEngineLibs } from "./helpers/deployEngineLibs";
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

describe("VRF callback budget with mask bets at the launch leg cap", function () {
    this.timeout(600_000);
    const MASK_LEGS_PER_MARKET = 1024;
    const results: Record<string, unknown> = {};
    const toJson = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
    after(function () {
        if (Object.keys(results).length === 0) return;
        mkdirSync("reports/mask-bets-v1", { recursive: true });
        writeFileSync("reports/mask-bets-v1/vrf-callback-budget.json", JSON.stringify({
            scope: "Local exact engine callback from impersonated configured coordinator (same method as deployments/vrf-callback-budget-2026-10-15.json); preview cost = gas of one previewPayoutBundle eth_call on the last chunk of a lane, measured by StaticCallGasProbe",
            gasLimit: 2_500_000, laneCount: 10, marketCount: 3, straightLegsPerMarket: 100, maskLegsPerMarket: MASK_LEGS_PER_MARKET,
            ...results,
        }, toJson, 2) + "\n");
    });

    async function measure(withMasks: boolean) {
        const s = await deployProtocolStack({ roundDuration: 3600 });
        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, s.admin]);
        await s.registry.write.setVaultBeacon([beacon.address]);
        const amount = 1_000_000n;
        for (let mid = 1; mid <= 3; mid++) {
            const asset = await viem.deployContract("MockUSDC");
            await s.registry.write.createMarket([{ asset: asset.address, bankAdmin: s.admin, minBet: amount }]);
            const bank = await viem.getContractAt("BankVault4626", (await s.registry.read.getMarket([mid])).bank);
            await asset.write.mint([s.admin, parseUnits("1000000", 6)]);
            await asset.write.approve([bank.address, parseUnits("1000000", 6)]);
            await bank.write.deposit([parseUnits("500000", 6), s.admin]);
            await s.engine.write.setMaskBetLimits([mid, MASK_LEGS_PER_MARKET, 10_000]);
            const straights = Array.from({ length: 100 }, () => ({ betType: 1n, number: 7n, amount }));
            await bank.write.placeBet([100n * amount, encodeMultiBet(straights), zeroAddress], { gas: 25_000_000n });
            if (!withMasks) continue;
            for (let done = 0; done < MASK_LEGS_PER_MARKET;) {
                const count = Math.min(64, MASK_LEGS_PER_MARKET - done);
                // Every mask covers the winning number 7: the worst case for the lane split and the sweep.
                const legs = Array.from({ length: count }, (_, k) => {
                    const index = (done + k) % 36;
                    const other = BigInt(index >= 7 ? index + 1 : index);
                    return { betType: 16n, number: (1n << 7n) | (1n << other), amount };
                });
                await bank.write.placeBet([BigInt(count) * amount, encodeMultiBet(legs), zeroAddress], { gas: 15_000_000n });
                done += count;
            }
            expect((await s.engine.read.maskBetState([1n, mid]))[2]).to.equal(BigInt(MASK_LEGS_PER_MARKET));
        }
        await time.increase(3700);
        const [, data] = await s.scheduler.read.checkUpkeep(["0x"]);
        await s.scheduler.write.performUpkeep([data]);
        const coordinator = s.vrf.address;
        await network.provider.send("hardhat_setBalance", [coordinator, "0x1000000000000000000"]);
        await network.provider.send("hardhat_impersonateAccount", [coordinator]);
        const publicClient = await viem.getPublicClient();
        try {
            const hash = await s.engine.write.rawFulfillRandomWords([1n, [7n, 8n]], { account: coordinator, gas: 2_500_000n });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            expect(receipt.status).to.equal("success");
            for (let mid = 1; mid <= 3; mid++) {
                const mr = await s.engine.read.marketRoundStateByRound([1n, mid]);
                expect(mr.winningBetCount).to.equal(BigInt(100 + (withMasks ? MASK_LEGS_PER_MARKET : 0)));
            }
            let previewGas = 0n;
            if (withMasks) {
                // Off-chain cost of a lane's LAST preview chunk at the cap: its final winner sits at the end
                // of the mask array, so the sweep walks all 1 024 masks. The cursor is jumped there through
                // the test harness (same storage, same linked libraries).
                const harnessImpl = await viem.deployContract(
                    "RouletteEngineHarness",
                    [s.vrf.address, `0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, `0x${"11".repeat(32)}`, 1, zeroAddress],
                    { libraries: await deployEngineLibs() },
                );
                await s.engine.write.upgradeToAndCall([harnessImpl.address, "0x"]);
                const harness = await viem.getContractAt("RouletteEngineHarness", s.engine.address);
                const probe = await viem.deployContract("StaticCallGasProbe");
                for (const lane of [0, 9]) {
                    const shardTotal = await harness.read.harnessWinningCountByShard([1n, 1, lane]);
                    await harness.write.harnessSetPayoutCursor([1n, 1, lane, shardTotal - 1n]);
                    const job = { kind: 2, marketId: 1, roundId: 1n, nextCursor: Number(shardTotal - 1n), payoutShardIndex: lane, payoutShardWidth: 10 };
                    // One eth_call measuring the inner call (eth_estimateGas re-executes it many times).
                    const gas = await probe.read.measure([s.engine.address, encodeFunctionData({
                        abi: s.engine.abi, functionName: "previewPayoutBundle", args: [job, 10],
                    })]);
                    if (gas > previewGas) previewGas = gas;
                    const [rows] = await s.engine.read.previewPayoutBundle([job, 10]);
                    expect(rows.length).to.equal(1);
                    expect(rows[0].amount).to.equal(18n * amount);
                }
            }
            return { callbackGas: receipt.gasUsed, previewGas };
        } finally {
            await network.provider.send("hardhat_stopImpersonatingAccount", [coordinator]);
        }
    }

    it("keeps the callback O(1) in the number of masks (3 markets × 1 024 masks + 100 straights)", async function () {
        const baseline = await measure(false);
        const masked = await measure(true);
        const delta = masked.callbackGas - baseline.callbackGas;
        Object.assign(results, {
            callbackGasWithoutMasks: baseline.callbackGas, callbackGasWithMasks: masked.callbackGas, callbackGasDelta: delta,
            previewPayoutBundleEthCallGasAtCap: masked.previewGas, maxPayoutsPerCall: 10,
        });
        console.log("MASK_VRF_CALLBACK_BUDGET", JSON.stringify(results, toJson));
        expect(masked.callbackGas < 2_500_000n).to.equal(true);
        // Closed-form lane split of the mask winners: a constant ≈ 2.2k gas per market (10-lane loop), the
        // same for 10 or 1 024 masks — never a walk over the masks. Measured 6 633 for 3 markets.
        expect(delta < 3n * 2_500n).to.equal(true);
    });
});
