import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    encodeFunctionData,
    parseUnits,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { laneCheckData } from "./helpers/parallelUpkeep";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";

const USDC = (v: string) => parseUnits(v, 6);
const GWEI = 1_000_000_000n;
const laneKey = () => ("0x" + "11".repeat(32)) as Hex;

const BetType = {
    COLOR_COUNT: 0,
    NUMBER_HIT: 1,
    CONSECUTIVE_STREAK: 2,
    RED_RATIO: 3,
    LIGHTNING_DOUBLE: 4,
    PERFECT_ALTERNATION: 5,
    DOZEN_HIT: 6,
    COLUMN_HIT: 7,
    JACKPOT_IN_WINDOW: 8,
} as const;

describe("Branch coverage — push to 100%", function () {
    describe("CoverageProbe revert instrumentation", function () {
        it("hits guarded revert branches via try/catch wrapper", async function () {
            const [admin] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const bankImpl = await viem.deployContract("BankVault4626");

            const badBankInit = {
                assetToken: usdc.address,
                name: "Bank",
                symbol: "b",
                marketId: 1,
                engine: mockEngine.address,
                admin: admin.account.address,
                minBet: 0n,
                sideBetController: zeroAddress,
            };
            await probe.write.tryBankInitialize([bankImpl.address, badBankInit], { account: admin.account });

            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        bankImpl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n),
                    ])
                ).address,
            );
            const bankAdminRole = await vault.read.BANK_ADMIN_ROLE();
            await vault.write.grantRole([bankAdminRole, probe.address], { account: admin.account });
            await probe.write.trySetSideBetController([vault.address, zeroAddress], { account: admin.account });
            await probe.write.trySetMinBet([vault.address, 0n], { account: admin.account });

            const testClient = await viem.getTestClient();
            await usdc.write.mint([probe.address, USDC("50")]);
            await testClient.impersonateAccount({ address: probe.address });
            await testClient.setBalance({ address: probe.address, value: parseUnits("10", 18) });
            await usdc.write.approve([vault.address, USDC("50")], { account: probe.address });
            await vault.write.deposit([USDC("20"), probe.address], { account: probe.address });
            const tinyBet = encodeSingleBet(1n, 7n, 1n);
            await probe.write.tryPlaceBet([vault.address, 1n, tinyBet, zeroAddress], { account: probe.address });
            await testClient.stopImpersonatingAccount({ address: probe.address });

            const brb = await viem.deployContract("BRBToken", [admin.account.address]);
            const router = await viem.deployContract("MockUniswapV2Router");
            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                admin.account.address,
                admin.account.address,
            ]);
            const funder = await viem.deployContract("BRBJackpotFunder", [
                admin.account.address,
                brb.address,
                router.address,
                treasury.address,
                admin.account.address,
                admin.account.address,
            ]);
            const funderAdminRole = await funder.read.FUNDER_ADMIN_ROLE();
            await funder.write.grantRole([funderAdminRole, probe.address], { account: admin.account });
            await funder.write.grantRole([funderAdminRole, probe.address], { account: admin.account });
            await probe.write.trySetSwapAssetBps([funder.address, 1001n], { account: admin.account });
            await probe.write.trySetTreasuryBrbSplit([funder.address, 2n, 1n], { account: admin.account });
            await probe.write.trySetTreasuryBrbSplit([funder.address, 1n, 0n], { account: admin.account });
            await probe.write.trySetSlippageBps([funder.address, 10_000n], { account: admin.account });

            const sideBetImpl = await viem.deployContract("SideBet");
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, zeroAddress, mockEngine.address, admin.account.address, 50_000, 5_000_000],
                { account: admin.account },
            );
            await probe.write.trySideBetInitialize(
                [
                    sideBetImpl.address,
                    admin.account.address,
                    mockEngine.address,
                    admin.account.address,
                    10_000,
                    5_000_000,
                ],
                { account: admin.account },
            );

            const stack = await deployProtocolStack();
            const { engine, deployer } = stack;
            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            await engine.write.grantRole([withdrawalRole, probe.address], { account: deployer.account });
            await probe.write.trySetWithdrawalQueueBatchSize([engine.address, 0n], { account: admin.account });
            await probe.write.trySetWithdrawalQueueBatchSize([engine.address, 21n], { account: admin.account });
            await probe.write.trySetMaxWithdrawalQueueLength([engine.address, 0n], { account: admin.account });
            await probe.write.trySetMaxWithdrawalQueueLength([engine.address, 1001n], { account: admin.account });

            const fixture = await deploySideBetStack(admin);
            const settlementRole = await fixture.sideBet.read.SETTLEMENT_ROLE();
            await fixture.sideBet.write.grantRole([settlementRole, probe.address], { account: admin.account });
            await probe.write.trySettleBatch([fixture.sideBet.address, [{ betId: 0n, won: true, payoutAmount: 1n }], []], {
                account: admin.account,
            });
        });
    });

    describe("Direct implementation initialize reverts", function () {
        it("RouletteEngine, BankVault4626, and SideBet hit each guard on the implementation", async function () {
            const [admin] = await viem.getWalletClients();
            const vrf = await viem.deployContract("MockVrfCoordinator");
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const libs = await deployEngineLibs();

            const engineImpl = await viem.deployContract(
                "RouletteEngine",
                [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: libs },
            );
            const engineCases = [
                { registry: zeroAddress },
                { jackpotTreasury: zeroAddress },
                { jackpotFunder: zeroAddress },
                { infraRecipient: zeroAddress },
                { admin: zeroAddress },
                { upkeepScheduler: zeroAddress },
                { roundDuration: 0 },
            ] as const;
            for (const patch of engineCases) {
                await expect(engineImpl.write.initialize([engineInitCfg(patch)])).to.be.rejected;
            }

            const bankImpl = await viem.deployContract("BankVault4626");
            await expect(
                bankImpl.write.initialize([
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 0n,
                        sideBetController: zeroAddress,
                    },
                ]),
            ).to.be.rejected;

            const sideBetImpl = await viem.deployContract("SideBet");
            const badSideBetInits: [Address, Address, Address, number, number][] = [
                [zeroAddress, mockEngine.address, admin.account.address, 50_000, 5_000_000],
                [admin.account.address, zeroAddress, admin.account.address, 50_000, 5_000_000],
                [admin.account.address, mockEngine.address, zeroAddress, 50_000, 5_000_000],
                [admin.account.address, mockEngine.address, admin.account.address, 10_000, 5_000_000],
                [admin.account.address, mockEngine.address, admin.account.address, 50_000, 40_000],
            ];
            for (const args of badSideBetInits) {
                await expect(sideBetImpl.write.initialize(args)).to.be.rejected;
            }
        });
    });

    describe("RouletteEngine setter and preview matrix", function () {
        it("covers valid setters, invalid bounds, preview guards, and harness paths", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, router, deployer } = stack;
            const testClient = await viem.getTestClient();

            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            const payoutRole = await engine.read.ENGINE_PAYOUT_ROLE();
            const roundRole = await engine.read.ENGINE_ROUND_ROLE();
            await engine.write.grantRole([withdrawalRole, admin.account.address], { account: admin.account });
            await engine.write.grantRole([payoutRole, admin.account.address], { account: admin.account });
            await engine.write.grantRole([roundRole, admin.account.address], { account: admin.account });

            await engine.write.setWithdrawalQueueBatchSize([6], { account: admin.account });
            await engine.write.setMaxWithdrawalQueueLength([100], { account: admin.account });
            await engine.write.setRoundDuration([480], { account: admin.account });
            await expect(engine.write.setWithdrawalQueueBatchSize([0], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setWithdrawalQueueBatchSize([21], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setMaxWithdrawalQueueLength([0], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setMaxWithdrawalQueueLength([1001], { account: admin.account })).to.be.rejected;

            const harnessImpl = await viem.deployContract(
                "RouletteEngineHarness",
                [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
            const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);
            await harness.write.harnessSetPayoutLaneCount([0]);
            await harness.read.findNextJob([0, 25, 0, 0]);
            expect(await harness.read.payoutParallelLaneCount()).to.equal(1n);
            await harness.write.harnessSetRoundMarketParticipantCount([1n, 0]);
            expect(await harness.read.harnessIsRoundDone([1n])).to.equal(false);

            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([router.address, parseUnits("1000000", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            expect(await bank.read.maxWithdraw([admin.account.address])).to.be.lte(USDC("2000"));
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });

            await expect(
                bank.write.placeBet([USDC("5"), encodeSingleBet(0n, 7n, USDC("5")), zeroAddress], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            const emptyPayload = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[], [], []],
            );
            await expect(
                bank.write.placeBet([USDC("5"), emptyPayload, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            const [foundBeforeLock] = await engine.read.findNextJob([0, 25, 0, 0]);
            expect(foundBeforeLock).to.equal(false);

            await time.increase(550);
            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            // TriggerVrf locks the round and requests VRF in one job.
            const trigger = { kind: 1, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            await engine.write.executeJob([trigger, [], [], []], { account: scheduler.address });
            // Duplicate VRF trigger reverts (raced-report guard).
            await expect(engine.write.executeJob([trigger, [], [], []], { account: scheduler.address })).to.be.rejected;

            const payoutJob = {
                kind: 2,
                marketId: 1,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 1,
            };
            expect(await engine.read.previewPayoutBundle([payoutJob, 10])).to.satisfy(
                (r: readonly [unknown[]]) => r[0].length === 0,
            );
            expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(false);

            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);
            expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(true);

            while (await engine.read.payoutLaneHasWork([payoutJob])) {
                // Apply validates nextCursor against the shard cursor, so refresh it each iteration.
                const fresh = {
                    ...payoutJob,
                    nextCursor: Number(await engine.read.payoutShardCursor([payoutJob.roundId, payoutJob.marketId, payoutJob.payoutShardIndex])),
                };
                const preview = await engine.read.previewPayoutBundle([fresh, 1]);
                await engine.write.executeJob([fresh, preview[0], preview[1], preview[2]], {
                    account: scheduler.address,
                });
            }
            await engine.write.executeJob([payoutJob, [], [], []], { account: scheduler.address });
            await testClient.stopImpersonatingAccount({ address: scheduler.address });
        });

        it("covers jackpot preview early exit and finalize idempotency", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, treasury, deployer } = stack;
            const testClient = await viem.getTestClient();
            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(8n, 0n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

            const payoutJob = {
                kind: 2,
                marketId: 1,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 1,
            };
            const previewJackpot = await engine.read.previewPayoutBundle([payoutJob, 10]);
            expect(previewJackpot[1].length).to.equal(0);

            while (await engine.read.payoutLaneHasWork([payoutJob])) {
                // Apply validates nextCursor against the shard cursor, so refresh it each iteration.
                const fresh = {
                    ...payoutJob,
                    nextCursor: Number(await engine.read.payoutShardCursor([payoutJob.roundId, payoutJob.marketId, payoutJob.payoutShardIndex])),
                };
                const p = await engine.read.previewPayoutBundle([fresh, 1]);
                await scheduler.write.performUpkeep([encodePerformData(fresh, p[0], p[1], p[2])]);
            }

            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            await engine.write.executeJob([payoutJob, [], [], []], { account: scheduler.address });
            await testClient.stopImpersonatingAccount({ address: scheduler.address });

            const harnessImpl = await viem.deployContract(
                "RouletteEngineHarness",
                [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
            const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);
            await harness.write.harnessSetRoundMarketParticipantCount([1n, 0]);
            expect(await harness.read.harnessIsRoundDone([1n])).to.equal(false);
        });

        const itVrfGas = process.env.SOLIDITY_COVERAGE === "true" ? it.skip : it;
        itVrfGas("covers VRF gas-price key hash tiers", async function () {
            const testClient = await viem.getTestClient();
            for (const gasPrice of [1n * GWEI, 10n * GWEI, 31n * GWEI] as const) {
                const [admin, alice] = await viem.getWalletClients();
                const stack = await deployProtocolStack();
                const { engine, scheduler, registry, vrf } = stack;
                const usdc = await viem.deployContract("MockUSDC");
                const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
                await usdc.write.mint([admin.account.address, USDC("3000")]);
                await usdc.write.approve([bank.address, USDC("3000")], { account: admin.account });
                await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
                await usdc.write.mint([alice.account.address, USDC("50")]);
                await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
                await bank.write.placeBet([USDC("5"), encodeSingleBet(1n, 3n, USDC("5")), zeroAddress], {
                    account: alice.account,
                });
                await time.increase(550);
                // VRF is requested in the TriggerVrf tx, so set the gas tier before it.
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: gasPrice });
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
                const roundId = await engine.read.currentGlobalRound();
                await vrf.write.fulfill([engine.address, roundId, 3n]);
            }
        });
    });

    describe("BankVault4626 withdraw and queue branches", function () {
        it("covers minBet revert, maxWithdraw cap, partial queue pay, and withdraw guards", async function () {
            const [admin, alice, bob] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        impl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 2_000_000n),
                    ])
                ).address,
            );

            await expect(vault.write.setSideBetController([zeroAddress], { account: admin.account })).to.be.rejected;
            await expect(vault.write.setMinBet([0n], { account: admin.account })).to.be.rejected;
            await vault.write.setMinBet([3_000_000n], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("200")]);
            await usdc.write.approve([vault.address, USDC("200")], { account: alice.account });
            await vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await expect(
                vault.write.placeBet([USDC("1"), encodeSingleBet(1n, 7n, USDC("1")), zeroAddress], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            await vault.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, USDC("95")]);
            const mwThin = await vault.read.maxWithdraw([alice.account.address]);
            expect(mwThin).to.be.lte(USDC("10"));

            await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            const balBefore = await usdc.read.balanceOf([vault.address]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
            const balAfter = await usdc.read.balanceOf([vault.address]);
            expect(balBefore - balAfter).to.be.gt(0n);
            expect(balBefore - balAfter).to.be.lt(USDC("100"));

            await vault.write.redeemBps([100, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await mockEngine.write.processWithdrawals([vault.address, 1n]);

            await expect(
                vault.write.withdraw([USDC("1"), zeroAddress, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeem([0n, alice.account.address, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeemBps([0, alice.account.address, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeemBps([100, alice.account.address, alice.account.address], { account: bob.account }),
            ).to.be.rejected;

            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf } = stack;
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: admin.account,
            });
            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await expect(
                bank.write.redeemBps([100, admin.account.address, admin.account.address], { account: admin.account }),
            ).to.be.rejected;
            await vrf.write.fulfill([engine.address, 1n, 7n]);
        });
    });

    describe("SideBet validation and settlement branches", function () {
        it("covers config OR arms, placeBet guards, preview, and settle row skip", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const fixture = await deploySideBetStack(admin);
            const { sideBet, bank, usdc, roundEngine } = fixture;

            const invalidConfigs: Record<string, unknown>[] = [
                { betType: BetType.COLOR_COUNT, targetCount: 0 },
                { betType: BetType.CONSECUTIVE_STREAK, targetCount: 0 },
                { betType: BetType.LIGHTNING_DOUBLE, targetCount: 1, windowSpins: 3 },
                { betType: BetType.DOZEN_HIT, targetNumber: 4, targetCount: 1 },
                { betType: BetType.COLUMN_HIT, targetNumber: 0, targetCount: 1 },
            ];
            for (const patch of invalidConfigs) {
                await expect(sideBet.write.addConfig([sideBetCfg(patch)], { account: admin.account })).to.be.rejected;
            }

            const validTypes: Record<string, unknown>[] = [
                { betType: BetType.COLOR_COUNT, targetCount: 2, windowSpins: 3 },
                { betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 },
                { betType: BetType.CONSECUTIVE_STREAK, targetCount: 2, windowSpins: 3 },
                { betType: BetType.RED_RATIO, redRatioBps: 5000, windowSpins: 3 },
                { betType: BetType.LIGHTNING_DOUBLE, targetNumber: 37, targetCount: 2, windowSpins: 3 },
                { betType: BetType.PERFECT_ALTERNATION, windowSpins: 2 },
                { betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 1, windowSpins: 3 },
                { betType: BetType.COLUMN_HIT, targetNumber: 2, targetCount: 1, windowSpins: 3 },
                { betType: BetType.JACKPOT_IN_WINDOW, windowSpins: 2 },
            ];
            for (const patch of validTypes) {
                await sideBet.write.addConfig([sideBetCfg(patch)], { account: admin.account });
                const id = (await sideBet.read.configCount()) - 1n;
                await sideBet.write.setConfigStakeLimits([id, USDC("1"), USDC("1000")], { account: admin.account });
            }

            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });

            await expect(sideBet.write.placeBet([999n, USDC("10")], { account: alice.account })).to.be.rejected;
            await sideBet.write.removeConfig([configId], { account: admin.account });
            await expect(sideBet.write.placeBet([configId, USDC("10")], { account: alice.account })).to.be.rejected;

            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const activeId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([activeId, USDC("1"), USDC("100")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([activeId, USDC("10")], { account: alice.account });

            const emptyPreview = await sideBet.read.previewSettleBundle([0n, 0, 0, 1]);
            expect(emptyPreview[0].length).to.equal(0);
            const lanePreview = await sideBet.read.previewSettleBundle([0n, 5, 0, 1]);
            expect(lanePreview[0].length).to.equal(0);

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await sideBet.write.settleBatch([[{ betId: 999n, won: true, payoutAmount: 1n }], []], {
                account: admin.account,
            });
            await expect(
                sideBet.write.settleBatch([[{ betId: 0n, won: true, payoutAmount: 1n }], []], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            await roundEngine.write.fulfillRounds([[8]]);
            await sideBet.write.settleBatch([[{ betId: 0n, won: false, payoutAmount: 0n }], []], {
                account: admin.account,
            });
        });
    });

    describe("BRBJackpotFunder and UpkeepScheduler", function () {
        it("covers setter revert arms and SideBet performUpkeep branch", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const brb = await viem.deployContract("BRBToken", [admin.account.address]);
            const router = await viem.deployContract("MockUniswapV2Router");
            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                admin.account.address,
                admin.account.address,
            ]);
            const funder = await viem.deployContract("BRBJackpotFunder", [
                admin.account.address,
                brb.address,
                router.address,
                treasury.address,
                admin.account.address,
                admin.account.address,
            ]);
            await expect(funder.write.setSwapAssetBps([1001], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setTreasuryBrbSplit([2, 1], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setTreasuryBrbSplit([1, 0], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setSlippageBps([10_000], { account: admin.account })).to.be.rejected;
            await funder.write.setSwapAssetBps([300], { account: admin.account });
            await funder.write.setTreasuryBrbSplit([250, 300], { account: admin.account });
            await funder.write.setSlippageBps([100], { account: admin.account });

            const usdc = await viem.deployContract("MockUSDC");
            const roundEngine = await viem.deployContract("MockRoundEngine");
            const vaultImpl = await viem.deployContract("BankVault4626");
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
            const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
            const scheduler = await viem.deployContract("UpkeepScheduler", [
                roundEngine.address,
                sideBet.address,
                admin.account.address,
                32,
                32,
            ]);
            await sideBet.write.grantRole([await sideBet.read.SETTLEMENT_ROLE(), scheduler.address], {
                account: admin.account,
            });
            await wireTestSchedulerForwarder(scheduler, admin.account);
            await scheduler.write.setScanLimit([48], { account: admin.account });
            await scheduler.write.setMaxPayoutsPerCall([6], { account: admin.account });

            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("1000")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[8]]);
            const [needed, data] = await scheduler.read.checkUpkeep(["0x"]);
            expect(needed).to.equal(true);
            expect(Number(decodeAbiParameters([{ type: "uint8" }], data)[0])).to.equal(1);
            await scheduler.write.performUpkeep([data]);
        });
    });

    describe("UpkeepScheduler SideBet-only performUpkeep", function () {
        it("enters SideBet branch in performUpkeep", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const roundEngine = await viem.deployContract("MockRoundEngine");
            const vaultImpl = await viem.deployContract("BankVault4626");
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
            const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
            const scheduler = await viem.deployContract("UpkeepScheduler", [
                roundEngine.address,
                sideBet.address,
                admin.account.address,
                32,
                32,
            ]);
            await sideBet.write.grantRole([await sideBet.read.SETTLEMENT_ROLE(), scheduler.address], {
                account: admin.account,
            });
            await wireTestSchedulerForwarder(scheduler, admin.account);
            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("1000")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[8]]);

            const [needed, data] = await scheduler.read.checkUpkeep(["0x"]);
            expect(needed).to.equal(true);
            const kind = decodeAbiParameters([{ type: "uint8" }], data)[0];
            expect(Number(kind)).to.equal(1);
            await scheduler.write.performUpkeep([data]);
            expect((await sideBet.read.getBet([0n])).status).to.equal(2);
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
        windowSpins: 1,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

function engineInitCfg(overrides: Partial<{
    registry: Address;
    jackpotTreasury: Address;
    jackpotFunder: Address;
    infraRecipient: Address;
    admin: Address;
    upkeepScheduler: Address;
    roundDuration: number;
}>) {
    const base = {
        registry: "0x0000000000000000000000000000000000000001" as Address,
        jackpotTreasury: "0x0000000000000000000000000000000000000002" as Address,
        jackpotFunder: "0x0000000000000000000000000000000000000003" as Address,
        infraRecipient: "0x0000000000000000000000000000000000000004" as Address,
        subscriptionId: 1n,
        callbackGasLimit: 2_000_000,
        roundDuration: 500,
        admin: "0x0000000000000000000000000000000000000005" as Address,
        upkeepScheduler: "0x0000000000000000000000000000000000000006" as Address,
    };
    return { ...base, ...overrides };
}

function vaultInit(asset: Address, engine: Address, admin: Address, minBet: bigint) {
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
                sideBetController: zeroAddress,
            },
        ],
    });
}

async function deploySideBetStack(admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0]) {
    const usdc = await viem.deployContract("MockUSDC");
    const roundEngine = await viem.deployContract("MockRoundEngine");
    const vaultImpl = await viem.deployContract("BankVault4626");
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
    const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    await usdc.write.mint([admin.account.address, USDC("10000")]);
    await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
    await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
    return { usdc, sideBet, bank, roundEngine };
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
