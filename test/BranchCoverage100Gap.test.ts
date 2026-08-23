import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, encodeFunctionData, parseUnits, zeroAddress, type Address, type Hex } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";
import { vaultInitMinBetUsdc6 } from "./helpers/marketLimits";

const USDC = (v: string) => parseUnits(v, 6);
const GWEI = 1_000_000_000n;

const BetType = {
    NUMBER_HIT: 0,
    COLOR_COUNT: 1,
    CONSECUTIVE_STREAK: 2,
    RED_RATIO: 3,
    LIGHTNING_DOUBLE: 4,
    PERFECT_ALTERNATION: 5,
    DOZEN_HIT: 6,
    COLUMN_HIT: 7,
    JACKPOT_IN_WINDOW: 8,
} as const;

describe("Branch coverage — final 100% gaps", function () {
    describe("BankVault4626", function () {
        function vaultInit(
            asset: Address,
            engine: Address,
            admin: Address,
            minBet: bigint,
            sideBetController: Address = zeroAddress,
        ): Hex {
            return encodeFunctionData({
                abi: [
                    {
                        type: "function",
                        name: "initialize",
                        inputs: [
                            {
                                name: "p",
                                type: "tuple",
                                components: [
                                    { name: "assetToken", type: "address" },
                                    { name: "name", type: "string" },
                                    { name: "symbol", type: "string" },
                                    { name: "marketId", type: "uint32" },
                                    { name: "engine", type: "address" },
                                    { name: "admin", type: "address" },
                                    { name: "minBet", type: "uint256" },
                                    { name: "sideBetController", type: "address" },
                                ],
                            },
                        ],
                    },
                ],
                functionName: "initialize",
                args: [
                    {
                        assetToken: asset,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine,
                        admin,
                        minBet,
                        sideBetController,
                    },
                ],
            });
        }

        it("covers AccessControl, reentrancy, queue math, and maxWithdraw cap arms", async function () {
            const [admin, alice, stranger, bob] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
            const reentrantEngine = await viem.deployContract("MockEngineReentrant");
            const impl = await viem.deployContract("BankVault4626Harness");
            const proxy = await viem.deployContract("ERC1967Proxy", [
                impl.address,
                vaultInit(usdc.address, reentrantEngine.address, admin.account.address, vaultInitMinBetUsdc6),
            ]);
            const vault = await viem.getContractAt("BankVault4626Harness", proxy.address);

            const initParams = {
                assetToken: usdc.address,
                name: "Dup",
                symbol: "d",
                marketId: 2,
                engine: reentrantEngine.address,
                admin: admin.account.address,
                minBet: vaultInitMinBetUsdc6,
                sideBetController: zeroAddress,
            };
            await probe.write.tryBankInitialize([vault.address, initParams], { account: admin.account });
            await probe.write.trySetSideBetController([vault.address, admin.account.address], { account: stranger.account });
            await probe.write.trySetMinBet([vault.address, 2_000_000n], { account: stranger.account });

            await reentrantEngine.write.setVault([vault.address]);
            await reentrantEngine.write.setReenter([true]);
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([vault.address, USDC("100")], { account: alice.account });
            await probe.write.tryPlaceBet([vault.address, USDC("10"), "0x", zeroAddress], { account: alice.account });
            await reentrantEngine.write.setReenter([false]);

            const capEngine = mockEngine;
            const capImpl = await viem.deployContract("BankVault4626Harness");
            const capProxy = await viem.deployContract("ERC1967Proxy", [
                capImpl.address,
                vaultInit(usdc.address, capEngine.address, admin.account.address, vaultInitMinBetUsdc6),
            ]);
            const capVault = await viem.getContractAt("BankVault4626Harness", capProxy.address);

            await usdc.write.mint([alice.account.address, USDC("200")]);
            await usdc.write.approve([capVault.address, USDC("200")], { account: alice.account });
            await capVault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await capVault.write.placeBet([USDC("10"), "0x", zeroAddress], { account: alice.account });
            await capEngine.write.transferOutFromVault([capVault.address, admin.account.address, USDC("95")]);

            const maxW = await capVault.read.maxWithdraw([alice.account.address]);
            expect(maxW).to.be.lte(USDC("10"));
            expect(maxW).to.be.gt(0n);

            await capVault.write.redeem([await capVault.read.balanceOf([alice.account.address]), alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await capEngine.write.processWithdrawals([capVault.address, 1n]);
            await probe.write.tryRedeemBps([capVault.address, 100, alice.account.address, alice.account.address], {
                account: stranger.account,
            });
            await probe.write.tryWithdraw([capVault.address, USDC("1"), alice.account.address, alice.account.address], {
                account: stranger.account,
            });

            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([capVault.address, USDC("100")], { account: alice.account });
            await capVault.write.deposit([USDC("50"), alice.account.address], { account: alice.account });

            // Zero-bps entry from a real holder: still queues a row that resolves to zero shares, so
            // the queue's zero-share arm stays covered. An address with no position at all is now
            // rejected upstream (H-2).
            await capVault.write.harnessEnqueueWithdrawal([alice.account.address, 0, alice.account.address], {
                account: alice.account,
            });
            await capEngine.write.processWithdrawals([capVault.address, 1n]);
            await capVault.write.withdraw([USDC("999"), alice.account.address, alice.account.address], { account: alice.account });

            await probe.write.tryWithdraw([capVault.address, USDC("1"), zeroAddress, alice.account.address], {
                account: alice.account,
            });
            await probe.write.tryRedeem([capVault.address, 0n, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await probe.write.tryRedeem([capVault.address, 1n, alice.account.address, alice.account.address], {
                account: stranger.account,
            });

            const fee = await capVault.read.flatWithdrawFee();
            const thinImpl = await viem.deployContract("BankVault4626Harness");
            const thinProxy = await viem.deployContract("ERC1967Proxy", [
                thinImpl.address,
                vaultInit(usdc.address, capEngine.address, admin.account.address, vaultInitMinBetUsdc6),
            ]);
            const thinVault = await viem.getContractAt("BankVault4626Harness", thinProxy.address);
            await usdc.write.mint([bob.account.address, USDC("20")]);
            await usdc.write.approve([thinVault.address, USDC("20")], { account: bob.account });
            await thinVault.write.deposit([USDC("10"), bob.account.address], { account: bob.account });
            await thinVault.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
            await capEngine.write.transferOutFromVault([
                thinVault.address,
                admin.account.address,
                (await usdc.read.balanceOf([thinVault.address])) - fee + 1n,
            ]);
            await capEngine.write.processWithdrawals([thinVault.address, 1n]);

            await usdc.write.mint([bob.account.address, USDC("20")]);
            await usdc.write.approve([thinVault.address, USDC("20")], { account: bob.account });
            await thinVault.write.deposit([USDC("10"), bob.account.address], { account: bob.account });
            await thinVault.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
            await capEngine.write.transferOutFromVault([thinVault.address, admin.account.address, USDC("10")]);
            await capEngine.write.processWithdrawals([thinVault.address, 1n]);
            await probe.write.tryRedeem([thinVault.address, 1n, bob.account.address, bob.account.address], {
                account: bob.account,
            });

            const cap2Impl = await viem.deployContract("BankVault4626Harness");
            const cap2Proxy = await viem.deployContract("ERC1967Proxy", [
                cap2Impl.address,
                vaultInit(usdc.address, capEngine.address, admin.account.address, vaultInitMinBetUsdc6),
            ]);
            const cap2Vault = await viem.getContractAt("BankVault4626Harness", cap2Proxy.address);
            await usdc.write.mint([bob.account.address, USDC("50")]);
            await usdc.write.approve([cap2Vault.address, USDC("50")], { account: bob.account });
            await cap2Vault.write.deposit([USDC("2"), bob.account.address], { account: bob.account });
            await cap2Vault.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
            await capEngine.write.transferOutFromVault([cap2Vault.address, admin.account.address, USDC("2")]);
            await capEngine.write.processWithdrawals([cap2Vault.address, 1n]);

            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([cap2Vault.address, USDC("100")], { account: alice.account });
            await cap2Vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await usdc.write.approve([cap2Vault.address, USDC("10")], { account: alice.account });
            await cap2Vault.write.placeBet([USDC("10"), "0x", zeroAddress], { account: alice.account });
            await capEngine.write.transferOutFromVault([cap2Vault.address, admin.account.address, USDC("95")]);
            const capped = await cap2Vault.read.maxWithdraw([alice.account.address]);
            const free = await cap2Vault.read.totalAssets();
            expect(capped).to.be.lte(free);
            expect(capped).to.be.gt(0n);
        });
    });

    describe("SideBet", function () {
        it("covers initialize guard, config OR arms, preview exits, inactive skip, and reentrancy", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const fixture = await deploySideBetHarnessStack(admin);
            const { sideBet, bank, usdc, roundEngine, registry } = fixture;
            const configRole = await sideBet.read.SIDE_BET_CONFIG_ROLE();
            await sideBet.write.grantRole([configRole, probe.address], { account: admin.account });

            const sideBetImpl = await viem.deployContract("SideBet");
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 9_999, 5_000_000],
                { account: admin.account },
            );
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 10_000, 5_000_000],
                { account: admin.account },
            );
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 50_000, 40_000],
                { account: admin.account },
            );

            const invalidCfgs = [
                sideBetCfg({ betType: BetType.COLOR_COUNT, targetCount: 0, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.COLOR_COUNT, targetCount: 4, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.CONSECUTIVE_STREAK, targetCount: 0, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.CONSECUTIVE_STREAK, targetCount: 4, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.RED_RATIO, redRatioBps: 0, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.RED_RATIO, redRatioBps: 10_001, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.LIGHTNING_DOUBLE, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.LIGHTNING_DOUBLE, targetCount: 4, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.DOZEN_HIT, targetNumber: 4, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 4, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.COLUMN_HIT, targetNumber: 0, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.COLUMN_HIT, targetNumber: 1, targetCount: 4, windowSpins: 3 }),
            ];
            for (const cfg of invalidCfgs) {
                await probe.write.tryAddConfig([sideBet.address, cfg], { account: admin.account });
            }

            await sideBet.write.addConfig([sideBetCfg({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 })], {
                account: admin.account,
            });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });

            expect((await sideBet.read.previewSettleBundle([0n, 0, 0, 0]))[0].length).to.equal(0);
            expect((await sideBet.read.previewSettleBundle([0n, 5, 0, 0]))[0].length).to.equal(0);
            expect((await sideBet.read.previewSettleBundle([0n, 5, 2, 1]))[0].length).to.equal(0);

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });

            await bank.write.configureSideBetReenter([sideBet.address, configId, USDC("5")]);
            await expect(sideBet.write.placeBet([configId, USDC("10")], { account: alice.account })).to.be.rejected;
            await bank.write.configureSideBetReenter([zeroAddress, 0n, 0n]);

            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[7]]);

            await probe.write.trySideBetPlaceBet([sideBet.address, configId, USDC("10")], { account: alice.account });

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await sideBet.write.grantRole([settlementRole, bank.address], { account: admin.account });
            await bank.write.configureSettleReenter([sideBet.address]);
            await probe.write.trySettleBatch([sideBet.address, [{ betId: 0n, won: true, payoutAmount: USDC("50") }], []], {
                account: admin.account,
            });
            await bank.write.configureSettleReenter([zeroAddress]);

            await sideBet.write.settleBatch([[{ betId: 0n, won: true, payoutAmount: USDC("50") }], []], {
                account: admin.account,
            });

            await sideBet.write.grantRole([settlementRole, probe.address], { account: admin.account });
            await probe.write.trySettleBatch([sideBet.address, [{ betId: 0n, won: true, payoutAmount: 1n }], []], {
                account: admin.account,
            });

            const settledPreview = await sideBet.read.previewSettleBundle([0n, 10, 0, 1]);
            expect(settledPreview[0].length).to.equal(0);
        });
    });

    describe("RouletteEngine", function () {
        afterEach(async function () {
            const testClient = await viem.getTestClient();
            await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
        });

        it("covers multi-bet guards, VRF tiers, payout previews, and jackpot preview edges", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const testClient = await viem.getTestClient();
            const stack = await deployProtocolStack({ maxPayoutsPerCall: 5 });
            const { engine, scheduler, registry, vrf, brb, treasury, deployer } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            expect(await engine.read.vrfActiveRound()).to.equal(0n);
            expect(await engine.read.hasPendingVrf()).to.equal(false);

            const badMulti = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[1n], [1n, 2n], [USDC("1")]],
            );
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });
            await expect(
                bank.write.placeBet([USDC("1"), badMulti, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            const payoutJobEmpty = {
                kind: 2,
                marketId: 1,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            expect(await engine.read.payoutLaneHasWork([payoutJobEmpty])).to.equal(false);
            expect((await engine.read.previewPayoutBundle([payoutJobEmpty, 0]))[0].length).to.equal(0);
            expect((await engine.read.previewPayoutBundle([payoutJobEmpty, 10]))[0].length).to.equal(0);

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: admin.account,
            });

            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(false);

            const harnessImpl = await viem.deployContract(
                "RouletteEngineHarness",
                [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
            const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);
            await harness.write.harnessClearRoundLockAt([1n]);
            expect((await harness.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(false);
            const lockAtPast = BigInt(await time.latest()) - 600n;
            await harness.write.harnessSetRoundLockAt([1n, lockAtPast]);
            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(true);

            // TriggerVrf performUpkeep locks the round and requests VRF in one tx.
            let [, data] = await scheduler.read.checkUpkeep(["0x"]);
            await scheduler.write.performUpkeep([data]);

            expect(await engine.read.hasPendingVrf()).to.equal(true);
            expect(await engine.read.vrfActiveRound()).to.equal(await engine.read.currentGlobalRound());
            await vrf.write.fulfill([engine.address, 1n, 7n]);
            expect(await engine.read.vrfActiveRound()).to.equal(0n);

            const payoutJob = {
                kind: 2,
                marketId: 1,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(true);
            const previewDuringSettle = await engine.read.previewPayoutBundle([payoutJob, 5]);
            expect(previewDuringSettle[0].length).to.be.lte(5);

            while (await engine.read.payoutLaneHasWork([payoutJob])) {
                // Apply validates nextCursor against the shard cursor, so refresh it each iteration.
                const fresh = {
                    ...payoutJob,
                    nextCursor: Number(await engine.read.payoutShardCursor([payoutJob.roundId, payoutJob.marketId, payoutJob.payoutShardIndex])),
                };
                const preview = await engine.read.previewPayoutBundle([fresh, 1]);
                await scheduler.write.performUpkeep([encodePerformData(fresh, preview[0], preview[1], preview[2])]);
            }

            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10000", 18) });
            const runVrfGasTiers = process.env.SOLIDITY_COVERAGE !== "true";
            if (runVrfGasTiers) {
                for (const gasPrice of [1n * GWEI, 10n * GWEI, 30n * GWEI] as const) {
                    await bank.write.placeBet([USDC("5"), encodeSingleBet(1n, 3n, USDC("5")), zeroAddress], {
                        account: admin.account,
                    });
                    await time.increase(550);
                    // VRF is requested in the TriggerVrf tx, so set the gas tier before it.
                    await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: gasPrice });
                    [, data] = await scheduler.read.checkUpkeep(["0x"]);
                    await scheduler.write.performUpkeep([data], { gasPrice: gasPrice + 1n });
                    await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
                    const reqId = (await vrf.read.nextRequestId()) - 1n;
                    await vrf.write.fulfill([engine.address, reqId, 3n]);
                    while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                        await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
                    }
                }
            }
            await testClient.stopImpersonatingAccount({ address: scheduler.address });

            await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
            await usdc.write.mint([admin.account.address, USDC("20000")]);
            await usdc.write.approve([bank.address, USDC("20000")], { account: admin.account });
            await bank.write.deposit([USDC("15000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("500")]);
            await usdc.write.approve([bank.address, USDC("500")], { account: alice.account });
            const betAmount = USDC("10");
            const betData7 = encodeSingleBet(1n, 7n, betAmount);
            for (let i = 0; i < 12; i++) {
                await bank.write.placeBet([betAmount, betData7, zeroAddress], { account: alice.account });
            }
            await time.increase(550);
            while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            }
            const jackpotRound = await engine.read.currentGlobalRound();
            const jackpotReqId = (await vrf.read.nextRequestId()) - 1n;
            await vrf.write.fulfillWithJackpot([engine.address, jackpotReqId, 7n, 7n]);

            const jackpotJob = {
                kind: 2,
                marketId: 1,
                roundId: jackpotRound,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            expect(await engine.read.payoutLaneHasWork([jackpotJob])).to.equal(true);
            const jackpotPreview = await engine.read.previewPayoutBundle([jackpotJob, 5]);
            expect(jackpotPreview[1].length).to.be.gt(0);

            let batches = 0;
            const laneCount = 10;
            for (let lane = 0; lane < laneCount; lane++) {
                const laneJob = { ...jackpotJob, payoutShardIndex: lane };
                while (await engine.read.payoutLaneHasWork([laneJob])) {
                    const fresh = {
                        ...laneJob,
                        nextCursor: Number(await engine.read.payoutShardCursor([laneJob.roundId, laneJob.marketId, lane])),
                    };
                    const p = await engine.read.previewPayoutBundle([fresh, 5]);
                    await scheduler.write.performUpkeep([encodePerformData(fresh, p[0], p[1], p[2])]);
                    batches++;
                }
            }
            expect(batches).to.be.gt(1);
            await runParallelLanesUntilIdle(scheduler);
            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            for (let lane = 0; lane < laneCount; lane++) {
                const laneJob = { ...jackpotJob, payoutShardIndex: lane };
                await engine.write.executeJob([laneJob, [], [], []], { account: scheduler.address });
            }
            await testClient.stopImpersonatingAccount({ address: scheduler.address });

            await bank.write.placeBet([USDC("10"), encodeSingleBet(8n, 0n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await time.increase(550);
            while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            }
            const noStraightRound = await engine.read.currentGlobalRound();
            const noStraightReqId = (await vrf.read.nextRequestId()) - 1n;
            await vrf.write.fulfillWithJackpot([engine.address, noStraightReqId, 7n, 7n]);
            const noStraightJackpotJob = {
                kind: 2,
                marketId: 1,
                roundId: noStraightRound,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            const noStakePreview = await engine.read.previewPayoutBundle([noStraightJackpotJob, 10]);
            expect(noStakePreview[1].length).to.equal(0);

            while (await engine.read.payoutLaneHasWork([noStraightJackpotJob])) {
                const fresh = {
                    ...noStraightJackpotJob,
                    nextCursor: Number(
                        await engine.read.payoutShardCursor([noStraightJackpotJob.roundId, noStraightJackpotJob.marketId, 0]),
                    ),
                };
                const p = await engine.read.previewPayoutBundle([fresh, 10]);
                await scheduler.write.performUpkeep([encodePerformData(fresh, p[0], p[1], p[2])]);
            }

            const usdc2 = await viem.deployContract("MockUSDC");
            const vaultImpl = await viem.deployContract("BankVault4626");
            const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
            await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
            await registry.write.createMarket(
                [{ asset: usdc2.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
                { account: admin.account },
            );
            const bank2 = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([2])).bank);
            await usdc2.write.mint([admin.account.address, USDC("1000")]);
            await usdc2.write.approve([bank2.address, USDC("1000")], { account: admin.account });
            await bank2.write.deposit([USDC("500"), admin.account.address], { account: admin.account });
            await bank2.write.placeBet([USDC("5"), encodeSingleBet(1n, 3n, USDC("5")), zeroAddress], {
                account: admin.account,
            });
            await time.increase(550);
            while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            }
            const market2Round = await engine.read.currentGlobalRound();
            const market2ReqId = (await vrf.read.nextRequestId()) - 1n;
            await vrf.write.fulfill([engine.address, market2ReqId, 3n]);

            const noJackpotJob = {
                kind: 2,
                marketId: 2,
                roundId: market2Round,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            const noJackpotPreview = await engine.read.previewPayoutBundle([noJackpotJob, 10]);
            expect(noJackpotPreview[2].length).to.equal(0);
        });
    });
});

function sideBetCfg(overrides: Record<string, unknown> = {}) {
    return {
        marketId: 1,
        betType: BetType.NUMBER_HIT,
        color: 0,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 50_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

async function deploySideBetStack(admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0]) {
    return deploySideBetHarnessStack(admin, false);
}

async function deploySideBetHarnessStack(
    admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0],
    useHarness = true,
) {
    const usdc = await viem.deployContract("MockUSDC");
    const roundEngine = await viem.deployContract("MockRoundEngine");
    const vaultImpl = await viem.deployContract(useHarness ? "BankVault4626Harness" : "BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    const { registry } = await deploySideBetRegistryStack({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
    });
    const { sideBet } = await deploySideBetProxy({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
        registry: registry.address,
        minMultiplierBps: 50_000,
        maxMultiplierBps: 5_000_000,
    });
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
        { account: admin.account },
    );
    const bank = await viem.getContractAt(
        useHarness ? "BankVault4626Harness" : "BankVault4626",
        (await registry.read.getMarket([1])).bank,
    );
    return { sideBet, bank, usdc, roundEngine, registry };
}

function laneKey() {
    return ("0x" + "22".repeat(32)) as `0x${string}`;
}

function encodePerformData(
    job: {
        kind: number;
        marketId: number;
        roundId: bigint;
        nextCursor: number;
        payoutShardIndex: number;
        payoutShardWidth: number;
    },
    vaultPayouts: unknown[],
    jackpotWinners: unknown[],
    jackpotAmounts: unknown[],
) {
    return encodeAbiParameters(
        [
            { type: "uint8" },
            { type: "uint256" },
            {
                type: "tuple",
                components: [
                    { name: "kind", type: "uint8" },
                    { name: "marketId", type: "uint32" },
                    { name: "roundId", type: "uint64" },
                    { name: "nextCursor", type: "uint32" },
                    { name: "payoutShardIndex", type: "uint32" },
                    { name: "payoutShardWidth", type: "uint32" },
                ],
            },
            { type: "tuple[]", components: [{ name: "player", type: "address" }, { name: "amount", type: "uint256" }] },
            { type: "address[]" },
            { type: "uint256[]" },
        ],
        [0, 0n, job, vaultPayouts, jackpotWinners, jackpotAmounts],
    );
}

async function deployEngineLibs() {
    const rouletteBetLib = await viem.deployContract("RouletteBetLib");
    const rouletteLib = await viem.deployContract("RouletteLib");
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib");
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib");
    const rouletteExposureLib = await viem.deployContract("RouletteExposureLib");
    const rouletteJackpotCollectLib = await viem.deployContract("RouletteJackpotCollectLib");
    const roulettePayoutSweepLib = await viem.deployContract("RoulettePayoutSweepLib", [], {
        libraries: {
            "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": rouletteBetLib.address,
            "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib": roulettePayoutMulLib.address,
        },
    });
    const rouletteLiabilityMathLib = await viem.deployContract("RouletteLiabilityMathLib", [], {
        libraries: { "contracts/RouletteLib.sol:RouletteLib": rouletteLib.address },
    });
    const rouletteBetCodecLib = await viem.deployContract("RouletteBetCodecLib", [], {
        libraries: { "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": rouletteBetLib.address },
    });
    return {
        "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": jackpotBatchLib.address,
        "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib": rouletteBetCodecLib.address,
        "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib": rouletteLiabilityMathLib.address,
        "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": roulettePayoutSweepLib.address,
        "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib": rouletteJackpotCollectLib.address,
        "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib": rouletteExposureLib.address,
    };
}
