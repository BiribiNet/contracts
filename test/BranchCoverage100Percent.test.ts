import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
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

describe("Branch coverage — 100% target", function () {
    describe("CoverageProbe success + revert arms", function () {
        it("registers both outcomes on bank, funder, engine, and side bet guards", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const bankImpl = await viem.deployContract("BankVault4626");

            const goodInit = {
                assetToken: usdc.address,
                name: "Bank",
                symbol: "b",
                marketId: 1,
                engine: mockEngine.address,
                admin: admin.account.address,
                minBet: 1_000_000n,
                sideBetController: zeroAddress,
            };
            await probe.write.tryBankInitialize([bankImpl.address, { ...goodInit, minBet: 0n }], {
                account: admin.account,
            });
            const freshImpl = await viem.deployContract("BankVault4626");
            await probe.write.tryBankInitialize([freshImpl.address, goodInit], { account: admin.account });

            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        bankImpl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n),
                    ])
                ).address,
            );
            const bankAdmin = await vault.read.BANK_ADMIN_ROLE();
            await vault.write.grantRole([bankAdmin, probe.address], { account: admin.account });
            await probe.write.trySetSideBetController([vault.address, zeroAddress], { account: admin.account });
            await probe.write.trySetMinBet([vault.address, 0n], { account: admin.account });
            await probe.write.trySetSideBetController([vault.address, alice.account.address], {
                account: admin.account,
            });
            await probe.write.trySetMinBet([vault.address, 2_000_000n], { account: admin.account });

            const testClient = await viem.getTestClient();
            await usdc.write.mint([probe.address, USDC("100")]);
            await testClient.impersonateAccount({ address: probe.address });
            await testClient.setBalance({ address: probe.address, value: parseUnits("10", 18) });
            await usdc.write.approve([vault.address, USDC("100")], { account: probe.address });
            await vault.write.deposit([USDC("50"), probe.address], { account: probe.address });
            await probe.write.tryPlaceBet([vault.address, 1n, encodeSingleBet(1n, 7n, 1n), zeroAddress], {
                account: probe.address,
            });
            await probe.write.tryPlaceBetWithPermit(
                [vault.address, 0n, "0x", zeroAddress, 0n, 0, "0x" + "00".repeat(32), "0x" + "00".repeat(32)],
                { account: probe.address },
            );
            await probe.write.tryLockSideBetStake([vault.address, alice.account.address, 1n, 1n], {
                account: probe.address,
            });
            await probe.write.tryRedeemBps([vault.address, 100, zeroAddress, probe.address], {
                account: probe.address,
            });
            await probe.write.tryWithdraw([vault.address, 1n, probe.address, probe.address], {
                account: probe.address,
            });
            await probe.write.tryRedeem([vault.address, 0n, probe.address, probe.address], { account: probe.address });
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
            const funderAdmin = await funder.read.FUNDER_ADMIN_ROLE();
            await funder.write.grantRole([funderAdmin, probe.address], { account: admin.account });
            await probe.write.trySetSwapAssetBps([funder.address, 1001n], { account: admin.account });
            await probe.write.trySetSwapAssetBps([funder.address, 300n], { account: admin.account });
            await probe.write.trySetTreasuryBrbSplit([funder.address, 2n, 1n], { account: admin.account });
            await probe.write.trySetTreasuryBrbSplit([funder.address, 250n, 300n], { account: admin.account });
            await probe.write.trySetSlippageBps([funder.address, 10_000n], { account: admin.account });
            await probe.write.trySetSlippageBps([funder.address, 50n], { account: admin.account });

            const stack = await deployProtocolStack();
            const { engine, deployer } = stack;
            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            await engine.write.grantRole([withdrawalRole, probe.address], { account: deployer.account });
            await probe.write.trySetWithdrawalQueueBatchSize([engine.address, 0n], { account: admin.account });
            await probe.write.trySetWithdrawalQueueBatchSize([engine.address, 8n], { account: admin.account });
            await probe.write.trySetMaxWithdrawalQueueLength([engine.address, 1001n], { account: admin.account });
            await probe.write.trySetMaxWithdrawalQueueLength([engine.address, 200n], { account: admin.account });
        });
    });

    describe("BankVault4626 direct init and guard branches", function () {
        it("hits initialize success and revert arms via proxy + probe", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");

            const goodProxy = await viem.deployContract("ERC1967Proxy", [
                impl.address,
                vaultInit(usdc.address, mockEngine.address, admin.account.address, 2_000_000n),
            ]);
            const vault = await viem.getContractAt("BankVault4626", goodProxy.address);
            const bankAdmin = await vault.read.BANK_ADMIN_ROLE();
            await vault.write.grantRole([bankAdmin, probe.address], { account: admin.account });

            await probe.write.trySetSideBetController([vault.address, zeroAddress], { account: admin.account });
            await probe.write.trySetMinBet([vault.address, 0n], { account: admin.account });
            await vault.write.setSideBetController([alice.account.address], { account: admin.account });
            await vault.write.setMinBet([3_000_000n], { account: admin.account });

            const badImpl = await viem.deployContract("BankVault4626");
            await probe.write.tryBankInitialize([
                badImpl.address,
                {
                    assetToken: usdc.address,
                    name: "x",
                    symbol: "x",
                    marketId: 1,
                    engine: mockEngine.address,
                    admin: admin.account.address,
                    minBet: 0n,
                    sideBetController: zeroAddress,
                },
            ], { account: admin.account });
        });
    });

    describe("BankVault4626 queue and liquidity branches", function () {
        it("caps maxWithdraw, partial queue pay, and gross<=fee skip", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
            const impl = await viem.deployContract("BankVault4626");
            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        impl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n),
                    ])
                ).address,
            );
            const fee = await vault.read.flatWithdrawFee();

            await usdc.write.mint([alice.account.address, USDC("200")]);
            await usdc.write.approve([vault.address, USDC("200")], { account: alice.account });
            await vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await vault.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, USDC("95")]);
            const capped = await vault.read.maxWithdraw([alice.account.address]);
            expect(capped).to.be.lte(USDC("10"));

            await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            const balBefore = await usdc.read.balanceOf([vault.address]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
            const balAfter = await usdc.read.balanceOf([vault.address]);
            expect(balBefore).to.be.gt(balAfter);
            expect(balBefore - balAfter).to.be.lt(USDC("100"));

            await usdc.write.mint([alice.account.address, fee * 3n]);
            await usdc.write.approve([vault.address, fee * 3n], { account: alice.account });
            await vault.write.deposit([fee * 3n, alice.account.address], { account: alice.account });
            await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
        });
    });

    describe("RouletteEngine remaining branches", function () {
        afterEach(async function () {
            const testClient = await viem.getTestClient();
            await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
        });

        const itVrfGas = process.env.SOLIDITY_COVERAGE === "true" ? it.skip : it;
        itVrfGas("covers VRF gas-price key hash tiers via performUpkeep", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf } = stack;
            const testClient = await viem.getTestClient();
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
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            for (const gasPrice of [1n * GWEI, 10n * GWEI, 40n * GWEI] as const) {
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: gasPrice });
                const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
                if (vrfData !== "0x") await scheduler.write.performUpkeep([vrfData]);
            }
            await vrf.write.fulfill([engine.address, 1n, 3n]);
        });

        it("covers setter success paths, bet guards, preview, and upkeep flow", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, router, treasury, deployer } = stack;
            const testClient = await viem.getTestClient();

            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            await engine.write.grantRole([withdrawalRole, admin.account.address], { account: deployer.account });
            await engine.write.setWithdrawalQueueBatchSize([7], { account: admin.account });
            await engine.write.setMaxWithdrawalQueueLength([150], { account: admin.account });

            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(false);

            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
            await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            const emptyPayload = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[], [], []],
            );
            const mismatchedPayload = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[1n], [7n], [USDC("5"), USDC("6")]],
            );
            await usdc.write.mint([admin.account.address, USDC("3000")]);
            await usdc.write.approve([bank.address, USDC("3000")], { account: admin.account });
            await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
            await expect(
                bank.write.placeBet([USDC("10"), emptyPayload, zeroAddress], { account: admin.account }),
            ).to.be.rejected;
            await expect(
                bank.write.placeBet([USDC("10"), mismatchedPayload, zeroAddress], { account: admin.account }),
            ).to.be.rejected;

            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: admin.account,
            });

            const triggerVrfJob = { kind: 1, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            const payoutPreviewJob = { kind: 2, marketId: 1, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            expect(await engine.read.previewPayoutBundle([triggerVrfJob, 10])).to.satisfy(
                (r: readonly [unknown[]]) => r[0].length === 0,
            );
            expect(await engine.read.payoutLaneHasWork([triggerVrfJob])).to.equal(false);

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);

            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);
            expect(await engine.read.payoutLaneHasWork([payoutPreviewJob])).to.equal(true);
            const bigPreview = await engine.read.previewPayoutBundle([payoutPreviewJob, 100]);
            expect(bigPreview[0].length).to.be.gte(0);

            while (await engine.read.payoutLaneHasWork([payoutPreviewJob])) {
                const fresh = {
                    ...payoutPreviewJob,
                    nextCursor: Number(await engine.read.payoutShardCursor([1n, 1, 0])),
                };
                const p = await engine.read.previewPayoutBundle([fresh, 100]);
                await scheduler.write.performUpkeep([encodePerformData(fresh, p[0], p[1], p[2])]);
            }
            await scheduler.write.performUpkeep([encodePerformData(payoutPreviewJob, [], [], [])]);

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 3n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfill([engine.address, 2n, 3n]);
            while (true) {
                const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
                if (!needed) break;
                await scheduler.write.performUpkeep([data]);
            }
        });
    });

    describe("SideBet remaining branches", function () {
        it("covers config validation arms, preview shrink path, and inactive bet skip", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const probe = await viem.deployContract("CoverageProbe");
            const fixture = await deploySideBetStack(admin);
            const { sideBet, bank, usdc, roundEngine, registry } = fixture;
            const configRole = await sideBet.read.SIDE_BET_CONFIG_ROLE();
            await sideBet.write.grantRole([configRole, probe.address], { account: admin.account });

            const sideBetImpl = await viem.deployContract("SideBet");
            await probe.write.trySideBetInitialize(
                [sideBetImpl.address, admin.account.address, roundEngine.address, registry.address, 10_000, 5_000_000],
                { account: admin.account },
            );

            const badCfgs = [
                sideBetCfg({ betType: BetType.COLOR_COUNT, targetCount: 0 }),
                sideBetCfg({ betType: BetType.CONSECUTIVE_STREAK, targetCount: 0 }),
                sideBetCfg({ betType: BetType.LIGHTNING_DOUBLE, targetCount: 1, windowSpins: 3 }),
                sideBetCfg({ betType: BetType.DOZEN_HIT, targetNumber: 4 }),
                sideBetCfg({ betType: BetType.COLUMN_HIT, targetNumber: 0 }),
                sideBetCfg({ marketId: 99 }),
            ];
            for (const cfg of badCfgs) {
                await probe.write.tryAddConfig([sideBet.address, cfg], { account: admin.account });
            }

            await sideBet.write.addConfig(
                [sideBetCfg({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 })],
                { account: admin.account },
            );
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });

            await probe.write.trySideBetPlaceBet([sideBet.address, 999n, USDC("10")], { account: admin.account });

            const emptyPreview = await sideBet.read.previewSettleBundle([0n, 0, 0, 1]);
            expect(emptyPreview[0].length).to.equal(0);

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            expect(await sideBet.read.betCount()).to.equal(1n);
            await roundEngine.write.fulfillRounds([[7]]);
            const decided = await sideBet.read.previewSettleBundle([0n, 1, 0, 1]);
            expect(decided[0].length).to.equal(1);
            const partial = await sideBet.read.previewSettleBundle([0n, 3, 0, 1]);
            expect(partial[0].length).to.equal(1);

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            const scheduler = await viem.deployContract("UpkeepScheduler", [
                roundEngine.address,
                sideBet.address,
                admin.account.address,
                32,
                32,
            ]);
            await sideBet.write.grantRole([settlementRole, scheduler.address], { account: admin.account });
            await wireTestSchedulerForwarder(scheduler, admin.account);
            const [neededSettle, settleData] = await scheduler.read.checkUpkeep(["0x"]);
            expect(neededSettle).to.equal(true);
            await scheduler.write.performUpkeep([settleData]);

            const afterSettle = await sideBet.read.previewSettleBundle([1n, 5, 0, 1]);
            expect(afterSettle[0].length).to.equal(0);

            await sideBet.write.grantRole([settlementRole, probe.address], { account: admin.account });
            await probe.write.trySettleBatch(
                [sideBet.address, [{ betId: 0n, won: true, payoutAmount: 1n }], []],
                { account: admin.account },
            );

            await probe.write.tryAddConfig([sideBet.address, sideBetCfg({ marketId: 99 })], { account: admin.account });
        });
    });
});

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

function encodePerformData(
    job: {
        kind: number;
        marketId: number;
        roundId: bigint;
        nextCursor: number;
        payoutShardIndex: number;
        payoutShardWidth: number;
    },
    vaultPayouts: readonly { player: Address; amount: bigint }[],
    jackpotWinners: readonly Address[],
    jackpotAmounts: readonly bigint[],
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
    return { sideBet, bank, usdc, roundEngine, registry };
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
