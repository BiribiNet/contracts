import "./coverageHooks";

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

describe("Branch coverage — last 16 arms", function () {
    describe("BankVault4626", function () {
        function vaultInit(asset: Address, engine: Address, admin: Address): Hex {
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
                        minBet: vaultInitMinBetUsdc6,
                        sideBetController: zeroAddress,
                    },
                ],
            });
        }

        it("covers partial queue pay, paid==0, and maxWithdraw cap", async function () {
            const [admin, alice, bob] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");

            async function deployVault(useHarness: boolean) {
                const impl = await viem.deployContract(useHarness ? "BankVault4626Harness" : "BankVault4626");
                const proxy = await viem.deployContract("ERC1967Proxy", [
                    impl.address,
                    vaultInit(usdc.address, mockEngine.address, admin.account.address),
                ]);
                return viem.getContractAt(useHarness ? "BankVault4626Harness" : "BankVault4626", proxy.address);
            }

            const vault = await deployVault(true);
            const plainVault = await deployVault(false);
            const fee = await vault.read.flatWithdrawFee();

            for (const v of [vault, plainVault]) {
                await usdc.write.mint([alice.account.address, USDC("120")]);
                await usdc.write.mint([bob.account.address, USDC("30")]);
                await usdc.write.approve([v.address, USDC("120")], { account: alice.account });
                await usdc.write.approve([v.address, USDC("30")], { account: bob.account });
                await v.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
                await v.write.deposit([USDC("20"), bob.account.address], { account: bob.account });
                await v.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
                await v.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
                await mockEngine.write.transferOutFromVault([
                    v.address,
                    admin.account.address,
                    (await usdc.read.balanceOf([v.address])) - fee,
                ]);
                await mockEngine.write.processWithdrawals([v.address, 2n]);

                await usdc.write.mint([bob.account.address, fee * 3n]);
                await usdc.write.approve([v.address, fee * 3n], { account: bob.account });
                await v.write.deposit([fee * 3n, bob.account.address], { account: bob.account });
                await v.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
                await mockEngine.write.transferOutFromVault([v.address, admin.account.address, await usdc.read.balanceOf([v.address])]);
                await mockEngine.write.processWithdrawals([v.address, 1n]);
            }

            await usdc.write.mint([alice.account.address, USDC("500")]);
            await usdc.write.approve([vault.address, USDC("500")], { account: alice.account });
            await vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await usdc.write.mint([bob.account.address, USDC("50")]);
            await usdc.write.approve([vault.address, USDC("50")], { account: bob.account });
            await vault.write.deposit([USDC("50"), bob.account.address], { account: bob.account });
            await vault.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, USDC("95")]);
            const parts = await vault.read.harnessMaxWithdrawParts([alice.account.address]);
            expect(parts[2]).to.equal(await vault.read.maxWithdraw([alice.account.address]));
            expect(parts[2]).to.be.lte(parts[1]);

            const gross = await usdc.read.balanceOf([vault.address]);
            await vault.write.harnessSetLockedBetLiquidity([gross - 1n]);
            const inflated = await vault.read.harnessMaxWithdrawParts([alice.account.address]);
            expect(inflated[2]).to.be.lte(inflated[1]);
        });
    });

    describe("SideBet", function () {
        it("covers initialize multiplier, dozen OR arm, and settleBatch reentrancy", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const usdc = await viem.deployContract("MockUSDC");
            const roundEngine = await viem.deployContract("MockRoundEngine");
            const vaultImpl = await viem.deployContract("BankVault4626Harness");
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
            const bank = await viem.getContractAt("BankVault4626Harness", (await registry.read.getMarket([1])).bank);

            const sideBetImpl = await viem.deployContract("SideBet");
            await expect(
                viem.deployContract("ERC1967Proxy", [
                    sideBetImpl.address,
                    encodeFunctionData({
                        abi: sideBetImpl.abi,
                        functionName: "initialize",
                        args: [admin.account.address, roundEngine.address, registry.address, 10_000, 5_000_000],
                    }),
                ]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("ERC1967Proxy", [
                    sideBetImpl.address,
                    encodeFunctionData({
                        abi: sideBetImpl.abi,
                        functionName: "initialize",
                        args: [admin.account.address, roundEngine.address, registry.address, 9_999, 5_000_000],
                    }),
                ]),
            ).to.be.rejected;

            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 10_000, 5_000_000],
                { account: admin.account },
            );
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 9_999, 5_000_000],
                { account: admin.account },
            );

            const configRole = await sideBet.read.SIDE_BET_CONFIG_ROLE();
            await sideBet.write.grantRole([configRole, probe.address], { account: admin.account });
            await probe.write.trySetMultiplierBand([sideBet.address, 10_000, 5_000_000], { account: admin.account });
            await probe.write.trySetMultiplierBand([sideBet.address, 5_000, 5_000_000], { account: admin.account });

            await probe.write.tryAddConfig(
                [
                    sideBet.address,
                    sideBetCfg({ betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 4, windowSpins: 3 }),
                ],
                { account: admin.account },
            );
            await expect(
                sideBet.write.addConfig(
                    [sideBetCfg({ betType: BetType.COLUMN_HIT, targetNumber: 2, targetCount: 5, windowSpins: 2 })],
                    { account: admin.account },
                ),
            ).to.be.rejected;
            await expect(
                sideBet.write.addConfig(
                    [sideBetCfg({ betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 0, windowSpins: 3 })],
                    { account: admin.account },
                ),
            ).to.be.rejected;
            await expect(
                sideBet.write.setMultiplierBand([10_000, 5_000_000], { account: admin.account }),
            ).to.be.rejected;

            await sideBet.write.addConfig(
                [sideBetCfg({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 })],
                { account: admin.account },
            );
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[7]]);

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await sideBet.write.grantRole([settlementRole, bank.address], { account: admin.account });

            const bundle = await sideBet.read.previewSettleBundle([0n, 10, 0, 1]);
            expect(bundle[2].length).to.be.gt(0);
            await bank.write.configureSettleReenter([sideBet.address]);
            await expect(
                sideBet.write.settleBatch([bundle[0], bundle[2]], { account: admin.account }),
            ).to.be.rejected;
            await bank.write.configureSettleReenter([zeroAddress]);

            await sideBet.write.settleBatch([bundle[0], bundle[2]], { account: admin.account });
        });
    });

    describe("RouletteEngine", function () {
        afterEach(async function () {
            const testClient = await viem.getTestClient();
            await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
        });

        it("covers preview guards, jackpot cursor, chunk cap, finalize idempotency, and jackpot preview exits", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const testClient = await viem.getTestClient();
            const stack = await deployProtocolStack({ maxPayoutsPerCall: 1 });
            const { engine, scheduler, registry, vrf, brb, treasury, deployer } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
            await usdc.write.mint([admin.account.address, USDC("30000")]);
            await usdc.write.approve([bank.address, USDC("30000")], { account: admin.account });
            await bank.write.deposit([USDC("20000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("500")]);
            await usdc.write.approve([bank.address, USDC("500")], { account: alice.account });

            const betAmount = USDC("10");
            const betData7 = encodeSingleBet(1n, 7n, betAmount);
            for (let i = 0; i < 11; i++) {
                await bank.write.placeBet([betAmount, betData7, zeroAddress], { account: alice.account });
            }

            await time.increase(550);
            while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            }
            const jackpotRound = await engine.read.currentGlobalRound();
            const jackpotReqId = (await vrf.read.nextRequestId()) - 1n;
            await vrf.write.fulfillWithJackpot([engine.address, jackpotReqId, 7n, 7n]);

            const harnessImpl = await viem.deployContract(
                "RouletteEngineHarness",
                [stack.vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
            const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);

            const laneCount = 10;
            const jackpotJob = {
                kind: 2,
                marketId: 1,
                roundId: jackpotRound,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: laneCount,
            };

            // L824: jackpot cursor past winner count
            const jackpotWinnerCount = (await engine.read.previewPayoutBundle([jackpotJob, 100]))[1].length;
            expect(jackpotWinnerCount).to.be.gt(0);
            await harness.write.harnessSetJackpotPreviewState([jackpotRound, true, false, 999]);
            await harness.write.harnessPreviewPayoutBundle([jackpotJob, 10]);
            expect((await engine.read.previewPayoutBundle([jackpotJob, 10]))[1].length).to.equal(0);
            await harness.write.harnessSetJackpotPreviewState([jackpotRound, true, false, 0]);

            await harness.write.harnessPayoutLaneHasWork([jackpotJob]);
            expect(await engine.read.payoutLaneHasWork([jackpotJob])).to.equal(true);
            await harness.write.harnessPreviewPayoutBundle([jackpotJob, 1]);
            const validPreview = await engine.read.previewPayoutBundle([jackpotJob, 1]);
            expect(validPreview[1].length).to.be.gt(0);
            await harness.write.harnessPayoutLaneHasWork([jackpotJob]);

            const badJob = { ...jackpotJob, kind: 1 };
            await harness.write.harnessPreviewPayoutBundle([badJob, 10]);
            expect((await engine.read.previewPayoutBundle([badJob, 10]))[0].length).to.equal(0);
            await harness.write.harnessPayoutLaneHasWork([badJob]);
            await harness.write.harnessPreviewPayoutBundle([jackpotJob, 0]);
            // L496 fall-through: valid payout job with maxPayoutsPerCall > 0
            await harness.write.harnessPreviewPayoutBundle([jackpotJob, 10]);
            await harness.write.harnessPreviewPayoutBundle([{ ...jackpotJob, payoutShardWidth: 0 }, 10]);
            await harness.write.harnessPayoutLaneHasWork([{ ...jackpotJob, payoutShardWidth: 0 }]);

            let previewCalls = 0;
            while (await engine.read.payoutLaneHasWork([jackpotJob])) {
                // Apply validates nextCursor against the shard cursor, so refresh it each iteration.
                const freshJackpotJob = {
                    ...jackpotJob,
                    nextCursor: Number(await engine.read.payoutShardCursor([jackpotJob.roundId, jackpotJob.marketId, 0])),
                };
                await harness.write.harnessPreviewPayoutBundle([freshJackpotJob, 1]);
                const p = await engine.read.previewPayoutBundle([freshJackpotJob, 1]);
                previewCalls++;
                if (p[1].length > 0) expect(p[1].length).to.equal(1);
                await scheduler.write.performUpkeep([encodePerformData(freshJackpotJob, p[0], p[1], p[2])]);
                if (previewCalls === 1) {
                    await harness.write.harnessPayoutLaneHasWork([jackpotJob]);
                    expect(await engine.read.payoutLaneHasWork([jackpotJob])).to.equal(true);
                }
            }
            expect(previewCalls).to.be.gte(11);

            // L571: jackpot cursor exhausted but distribution flag still open
            await harness.write.harnessSetJackpotPreviewState([jackpotRound, true, false, jackpotWinnerCount]);
            await harness.write.harnessPayoutLaneHasWork([jackpotJob]);

            await runParallelLanesUntilIdle(scheduler);
            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            for (let lane = 0; lane < laneCount; lane++) {
                const laneJob = { ...jackpotJob, payoutShardIndex: lane };
                await engine.write.executeJob([laneJob, [], [], []], { account: scheduler.address });
                await engine.write.executeJob([laneJob, [], [], []], { account: scheduler.address });
            }
            await testClient.stopImpersonatingAccount({ address: scheduler.address });
            await runParallelLanesUntilIdle(scheduler);
            expect(await engine.read.currentGlobalRound()).to.be.gt(jackpotRound);

            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 0n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await time.increase(550);
            while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            }
            const noStraightRound = await engine.read.currentGlobalRound();
            const noStraightReqId = (await vrf.read.nextRequestId()) - 1n;
            await vrf.write.fulfillWithJackpot([engine.address, noStraightReqId, 7n, 7n]);

            const noStraightJob = {
                kind: 2,
                marketId: 1,
                roundId: noStraightRound,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: laneCount,
            };
            const emptyJackpotPreview = await engine.read.previewPayoutBundle([noStraightJob, 10]);
            expect(emptyJackpotPreview[1].length).to.equal(0);
            await harness.write.harnessPreviewPayoutBundle([noStraightJob, 10]);

            // L773: double finalize on losing round before scheduler drains lane 0
            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            await engine.write.executeJob([noStraightJob, [], [], []], { account: scheduler.address });
            await engine.write.executeJob([noStraightJob, [], [], []], { account: scheduler.address });
            await testClient.stopImpersonatingAccount({ address: scheduler.address });

            while (await engine.read.payoutLaneHasWork([noStraightJob])) {
                const p = await engine.read.previewPayoutBundle([noStraightJob, 10]);
                await scheduler.write.performUpkeep([encodePerformData(noStraightJob, p[0], p[1], p[2])]);
            }
            await runParallelLanesUntilIdle(scheduler);
            const drainedPreview = await engine.read.previewPayoutBundle([noStraightJob, 10]);
            expect(drainedPreview[1].length).to.equal(0);

            // L496/L534 guard arms via harness tx calls
            await harness.write.harnessPreviewPayoutBundle([noStraightJob, 0]);
            await harness.write.harnessPayoutLaneHasWork([{ ...noStraightJob, payoutShardWidth: 0 }]);

            // L577 chunk cap: vault shard preview respects maxPayoutsPerCall=1
            expect(validPreview[0].length).to.be.lte(1);
        });

        it("covers VRF gas-price key hash tiers", async function () {
            const testClient = await viem.getTestClient();

            for (const gasPrice of [1n * GWEI, 10n * GWEI, 30n * GWEI] as const) {
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
                await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]], {
                    gasPrice: gasPrice + 1n,
                });
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });

                expect(await engine.read.hasPendingVrf()).to.equal(true);
                const reqId = (await vrf.read.nextRequestId()) - 1n;
                await vrf.write.fulfill([engine.address, reqId, 3n]);
                while ((await scheduler.read.checkUpkeep(["0x"]))[0]) {
                    await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
                }
            }
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

function laneKey() {
    return ("0x" + "33".repeat(32)) as `0x${string}`;
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
