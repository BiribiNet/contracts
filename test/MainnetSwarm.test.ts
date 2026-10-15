import { viem, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseEther, parseEventLogs, zeroAddress } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { createMarketWithBeacon } from "./helpers/createMarket";
import { encodeMultiBet, straightLegs } from "./helpers/multiBetEncode";
import { laneCheckData, runParallelLanesUntilVrfPending } from "./helpers/parallelUpkeep";

// Opt-in because this submits tens of thousands of real stored bet legs.
// All writes are restricted to Hardhat's isolated, in-process chain.
(process.env.RUN_MAINNET_SWARM === "1" ? describe : describe.skip)("Mainnet BRB swarm", function () {
    this.timeout(1_800_000);
    for (const count of (process.env.SWARM_COUNTS ?? "250,1000").split(",").map(Number)) {
        for (const jackpot of [false, true]) {
            it(`${count} tickets × 37 numbers × 1 BRB, jackpot=${jackpot}`, async function () {
                expect(network.name).to.equal("hardhat");
                const pc = await viem.getPublicClient();
                expect(await pc.getChainId()).to.equal(31337);
                expect(Number.isSafeInteger(count) && count > 200 && count <= 10_000).to.equal(true);
                const { brb, registry, engine, scheduler, vrf, treasury, admin } =
                    await deployProtocolStack({ roundDuration: 1_000_000, maxPayoutsPerCall: 60 });
                const bank = await createMarketWithBeacon(registry as any, admin, brb.address, parseEther("1"));
                await brb.write.approve([bank.address, parseEther("1000000")]);
                await bank.write.deposit([parseEther("1000000"), admin]);
                await brb.write.transfer([treasury.address, parseEther("10000")]);
                const wallets = (await viem.getWalletClients()).slice(1);
                const active = wallets.slice(0, Math.min(wallets.length, count));
                for (const wallet of active) {
                    const budget = parseEther(String(37 * (Math.ceil(count / active.length) + 1)));
                    await brb.write.transfer([wallet.account.address, budget]);
                    await brb.write.approve([bank.address, budget], { account: wallet.account });
                }
                const before = await Promise.all(active.map(w => brb.read.balanceOf([w.account.address])));
                const bet = encodeMultiBet(straightLegs(37, parseEther("1")));
                let maxBetGas = 0n;
                for (let i = 0; i < count; i++) {
                    const hash = await bank.write.placeBet([parseEther("37"), bet, zeroAddress], {
                        account: active[i % active.length].account,
                    });
                    const receipt = await pc.waitForTransactionReceipt({ hash });
                    expect(receipt.status).to.equal("success");
                    if (receipt.gasUsed > maxBetGas) maxBetGas = receipt.gasUsed;
                    if ((i + 1) % 250 === 0) console.log(`    stored ${i + 1}/${count} tickets`);
                }
                await time.increase(1_000_100);
                await runParallelLanesUntilVrfPending(engine, scheduler);
                const events = await pc.getContractEvents({ address: engine.address, abi: engine.abi, eventName: "VrfRequested", fromBlock: 0n });
                const req = events.at(-1)!.args.requestId!;
                const hash = await vrf.write.fulfillGasCapped([engine.address, req, 7n, jackpot ? 7n : 8n, 2_500_000], { gas: 3_000_000n });
                const callbackReceipt = await pc.waitForTransactionReceipt({ hash });
                const callback = parseEventLogs({ abi: vrf.abi, logs: callbackReceipt.logs, eventName: "GasCappedFulfillment" })[0].args;
                const result: Record<string, unknown> = {
                    tickets: count, betLegs: count * 37, uniqueWallets: active.length, jackpot,
                    callbackSuccess: callback.success, callbackGas: String(callback.gasUsed), maxBetGas: String(maxBetGas),
                    settlementGasLimit: 2_500_000, maxSettlementGas: "0", calls: 0, completed: false,
                };
                let failure: string | undefined;
                let maxSettlement = 0n;
                if (callback.success) {
                    try {
                        for (let sweep = 0; sweep < count + 50; sweep++) {
                            if ((await engine.read.currentGlobalRound()) === 2n) break;
                            let progressed = false;
                            for (let lane = 0n; lane < 10n; lane++) {
                                const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(lane)], { gas: 25_000_000n });
                                if (!needed) continue;
                                progressed = true;
                                const tx = await scheduler.write.performUpkeep([data], { gas: 2_500_000n });
                                const receipt = await pc.waitForTransactionReceipt({ hash: tx });
                                expect(receipt.status).to.equal("success");
                                if (receipt.gasUsed > maxSettlement) maxSettlement = receipt.gasUsed;
                                result.calls = Number(result.calls) + 1;
                            }
                            if (!progressed) throw new Error("settlement became idle before next round");
                        }
                        result.completed = (await engine.read.currentGlobalRound()) === 2n;
                        const after = await Promise.all(active.map(w => brb.read.balanceOf([w.account.address])));
                        const delta = after.reduce((sum, balance, i) => sum + balance - before[i], 0n);
                        // Each ticket loses exactly 1 BRB to the house; a triggered jackpot
                        // additionally distributes the complete 10,000 BRB seeded pool.
                        expect(delta).to.equal(parseEther(String((jackpot ? 10_000 : 0) - count)));
                        if (jackpot) expect(await treasury.read.jackpotPool()).to.equal(0n);
                    } catch (error) {
                        // No raw RPC URLs / credential-bearing transport errors in artifacts.
                        failure = error instanceof Error && /gas|revert/i.test(error.message) ? "settlement transaction reverted or exceeded gas budget" : "settlement/accounting assertion failed";
                    }
                }
                result.maxSettlementGas = String(maxSettlement);
                if (failure) result.failure = failure;
                mkdirSync("reports/swarm", { recursive: true });
                writeFileSync(`reports/swarm/${count}-${jackpot ? "jackpot" : "normal"}.json`, JSON.stringify(result, null, 2) + "\n");
                console.log(JSON.stringify(result));
                expect(callback.success, "VRF exact-gas callback failed").to.equal(true);
                expect(failure, "settlement failed at production write gas limit").to.equal(undefined);
                expect(result.completed).to.equal(true);
            });
        }
    }
});
