import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
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

function vaultInit(
    asset: Address,
    engine: Address,
    admin: Address,
    minBet: bigint,
    sideBet: Address = zeroAddress,
) {
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
                sideBetController: sideBet,
            },
        ],
    });
}

describe("Branch coverage — last 102 branches", function () {
    describe("MarketRegistry _registerNextMarket", function () {
        it("reverts when asset or bank is zero", async function () {
            const [admin] = await viem.getWalletClients();
            const harness = await viem.deployContract("MarketRegistryHarness", [
                admin.account.address,
                admin.account.address,
                admin.account.address,
            ]);
            await expect(harness.write.testRegisterNextMarket([zeroAddress, admin.account.address])).to.be.rejected;
            await expect(harness.write.testRegisterNextMarket([admin.account.address, zeroAddress])).to.be.rejected;
        });
    });

    describe("BankVault4626 remaining branches", function () {
        it("covers initialize emit, admin setters, placeBet, withdraw guards, and liquidity caps", async function () {
            const [admin, alice, bob] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
            const sideBetAddr = bob.account.address;
            const impl = await viem.deployContract("BankVault4626");

            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        impl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n, sideBetAddr),
                    ])
                ).address,
            );

            await vault.write.setSideBetController([admin.account.address], { account: admin.account });
            await vault.write.setMinBet([2_000_000n], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("200")]);
            await usdc.write.approve([vault.address, USDC("200")], { account: alice.account });
            await vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await vault.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            expect(await vault.read.maxWithdraw([alice.account.address])).to.be.lte(USDC("100"));
            expect(await vault.read.maxRedeem([alice.account.address])).to.be.gt(0n);

            await expect(
                vault.write.redeemBps([1000, alice.account.address, alice.account.address], { account: bob.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeemBps([1000, zeroAddress, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.withdraw([0n, alice.account.address, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.withdraw([USDC("1"), zeroAddress, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeem([0n, alice.account.address, alice.account.address], { account: alice.account }),
            ).to.be.rejected;

            await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
            const fee = await vault.read.flatWithdrawFee();
            await mockEngine.write.transferOutFromVault([
                vault.address,
                admin.account.address,
                (await usdc.read.balanceOf([vault.address])) - fee,
            ]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
        });

        it("blocks deposit while engine reports restricted liquidity", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            await usdc.write.mint([admin.account.address, USDC("20000")]);
            await usdc.write.approve([bank.address, USDC("20000")], { account: admin.account });
            await bank.write.deposit([USDC("10000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await expect(
                bank.write.deposit([USDC("1"), alice.account.address], { account: alice.account }),
            ).to.be.rejected;

            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfill([engine.address, 1n, 7n]);
        });
    });

    describe("BRBJackpotFunder admin + swap burn", function () {
        it("covers setter happy paths and USDC swap with burn", async function () {
            const [admin] = await viem.getWalletClients();
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
            const usdc = await viem.deployContract("MockUSDC");

            await funder.write.setSwapAssetBps([300], { account: admin.account });
            await funder.write.setTreasuryBrbSplit([250, 300], { account: admin.account });
            await funder.write.setSlippageBps([100], { account: admin.account });

            await brb.write.transfer([router.address, parseUnits("1000000", 18)], { account: admin.account });
            await usdc.write.mint([funder.address, USDC("100")]);
            const supplyBefore = await brb.read.totalSupply();
            await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
            expect(await treasury.read.jackpotPool()).to.be.gt(0n);
            expect(await brb.read.totalSupply()).to.be.lt(supplyBefore);
        });
    });

    describe("LPVestingLock + ProtocolTimelock success paths", function () {
        it("releases via both overloads and runs timelock execute/cancel", async function () {
            const [admin, beneficiary, proposer, executor] = await viem.getWalletClients();
            const lp = await viem.deployContract("MockUSDC");
            const lock = await viem.deployContract("LPVestingLock", [
                lp.address,
                beneficiary.account.address,
                admin.account.address,
            ]);
            await lp.write.mint([lock.address, USDC("20")]);
            await time.increase(3 * 365 * 24 * 60 * 60 + 1);
            await lock.write.release([beneficiary.account.address], { account: beneficiary.account });
            await lp.write.mint([lock.address, USDC("5")]);
            await lock.write.release([beneficiary.account.address, USDC("3")], { account: beneficiary.account });

            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            const callee = await viem.deployContract("MockTimelockCallee");
            const salt = 99n;
            await timelock.write.queue([callee.address, 0n, "0x", salt], { account: proposer.account });
            await time.increase(24 * 3600 + 1);
            await timelock.write.execute([callee.address, 0n, "0x", salt], { account: executor.account });
            await timelock.write.queue([callee.address, 0n, "0x", salt + 1n], { account: proposer.account });
            const id2 = await timelock.read.operationId([callee.address, 0n, "0x", salt + 1n]);
            await timelock.write.cancel([id2], { account: admin.account });
        });
    });

    describe("UpkeepManager + UpkeepScheduler", function () {
        it("registers lane upkeep and updates scheduler admin knobs", async function () {
            const [admin] = await viem.getWalletClients();
            const link = await viem.deployContract("MockLinkToken");
            const registrar = await viem.deployContract("MockKeeperRegistry");
            const manager = await viem.deployContract("UpkeepManager", [
                link.address,
                registrar.address,
                registrar.address,
                admin.account.address,
                admin.account.address,
                admin.account.address,
            ]);
            await link.write.approve([manager.address, parseUnits("10", 18)]);
            await manager.write.registerLaneUpkeep([0n, 400_000, parseUnits("1", 18), admin.account.address], {
                account: admin.account,
            });

            const stack = await deployProtocolStack();
            const { scheduler, deployer } = stack;
            await scheduler.write.setForwarderAuthority([manager.address], { account: deployer.account });
            await scheduler.write.setScanLimit([48], { account: deployer.account });
            await scheduler.write.setMaxPayoutsPerCall([6], { account: deployer.account });
        });

        it("performUpkeep SideBet settlement path", async function () {
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
            await sideBet.write.addConfig(
                [
                    {
                        marketId: 1,
                        betType: 1,
                        color: 0,
                        targetNumber: 7,
                        targetCount: 1,
                        redRatioBps: 0,
                        windowSpins: 1,
                        multiplierBps: 100_000,
                        minStake: 0n,
                        maxStake: 0n,
                    },
                ],
                { account: admin.account },
            );
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("1000")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[8]]);
            const [, data] = await scheduler.read.checkUpkeep(["0x"]);
            expect(Number(decodeAbiParameters([{ type: "uint8" }], data)[0])).to.equal(1);
            await scheduler.write.performUpkeep([data]);
        });
    });

    describe("RouletteEngine lock, VRF, preview, and executeJob matrix", function () {
        it("covers unauthorized caller, registry mismatch, bad bets, preview guards, and scheduler jobs", async function () {
            const [admin, alice, bob] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, router, treasury } = stack;
            const testClient = await viem.getTestClient();
            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
            await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            await engine.write.grantRole([withdrawalRole, admin.account.address], { account: admin.account });
            await engine.write.setWithdrawalQueueBatchSize([8], { account: admin.account });
            await engine.write.setMaxWithdrawalQueueLength([120], { account: admin.account });

            const brbReferral = await engine.read.BRB_REFERRAL();
            const v2 = await viem.deployContract("RouletteEngine", [vrf.address, ...Array(3).fill(("0x" + "11".repeat(32)) as Hex), 1, brbReferral], {
                libraries: await deployEngineLibs(),
            });
            await engine.write.upgradeToAndCall([v2.address, "0x"], { account: admin.account });

            await testClient.impersonateAccount({ address: registry.address });
            await testClient.setBalance({ address: registry.address, value: parseUnits("10", 18) });
            await expect(
                engine.write.registerMarketFromRegistry([1, bob.account.address], { account: registry.address }),
            ).to.be.rejected;
            await testClient.stopImpersonatingAccount({ address: registry.address });

            await expect(
                engine.write.executeJob(
                    [{ kind: 1, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 }, [], [], []],
                    { account: bob.account },
                ),
            ).to.be.rejected;

            const badSum = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[1n], [7n], [USDC("5"), USDC("6")]],
            );
            await usdc.write.mint([admin.account.address, USDC("3000")]);
            await usdc.write.approve([bank.address, USDC("3000")], { account: admin.account });
            await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });

            await expect(
                bank.write.placeBet([USDC("10"), badSum, zeroAddress], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                bank.write.placeBet([USDC("10"), encodeSingleBet(99n, 7n, USDC("10")), zeroAddress], {
                    account: alice.account,
                }),
            ).to.be.rejected;
            await expect(
                bank.write.placeBet([USDC("10"), "0x" as Hex, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            const emptyPayload = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[], [], []],
            );
            await expect(
                bank.write.placeBet([USDC("10"), emptyPayload, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), bob.account.address], {
                account: alice.account,
            });

            const preLockJob = { kind: 1, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            expect(await engine.read.previewPayoutBundle([preLockJob, 10])).to.satisfy((r: readonly [unknown[]]) => r[0].length === 0);
            expect(await engine.read.payoutLaneHasWork([preLockJob])).to.equal(false);

            await time.increase(550);
            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
            await engine.write.executeJob([preLockJob, [], [], []], { account: scheduler.address });
            await engine.write.executeJob([preLockJob, [], [], []], { account: scheduler.address });

            const triggerJob = { kind: 2, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            await engine.write.executeJob([triggerJob, [], [], []], { account: scheduler.address });
            await engine.write.executeJob([triggerJob, [], [], []], { account: scheduler.address });

            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

            const payoutJob = { kind: 3, marketId: 1, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(true);
            const preview = await engine.read.previewPayoutBundle([payoutJob, 1]);
            await engine.write.executeJob([payoutJob, preview[0], preview[1], preview[2]], { account: scheduler.address });
            while (await engine.read.payoutLaneHasWork([payoutJob])) {
                const p = await engine.read.previewPayoutBundle([payoutJob, 1]);
                await engine.write.executeJob([payoutJob, p[0], p[1], p[2]], { account: scheduler.address });
            }

            const settledPreview = await engine.read.previewPayoutBundle([payoutJob, 10]);
            expect(settledPreview[0].length).to.equal(0);
            await engine.write.executeJob([payoutJob, [], [], []], { account: scheduler.address });

            await expect(vrf.write.fulfill([engine.address, 999n, 1n])).to.be.rejected;
            await testClient.stopImpersonatingAccount({ address: scheduler.address });
        });
    });

    describe("SideBet remaining branches", function () {
        it("covers zero-bank registry, config admin, preview guards, invalid rows, and upgrade", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const mockRegistry = await viem.deployContract("MockMarketRegistryZeroBank");
            const roundEngine = await viem.deployContract("MockRoundEngine");
            const sideBetImpl = await viem.deployContract("SideBet");
            const init = encodeFunctionData({
                abi: sideBetImpl.abi,
                functionName: "initialize",
                args: [admin.account.address, roundEngine.address, mockRegistry.address, 50_000, 5_000_000],
            });
            const sideBet = await viem.getContractAt(
                "SideBet",
                (await viem.deployContract("ERC1967Proxy", [sideBetImpl.address, init])).address,
            );

            await expect(
                sideBet.write.addConfig(
                    [
                        {
                            marketId: 1,
                            betType: 1,
                            color: 0,
                            targetNumber: 7,
                            targetCount: 1,
                            redRatioBps: 0,
                            windowSpins: 1,
                            multiplierBps: 100_000,
                            minStake: 0n,
                            maxStake: 0n,
                        },
                    ],
                    { account: admin.account },
                ),
            ).to.be.rejected;

            const { usdc, sideBet: sb, bank, roundEngine: re } = await deploySideBetStack(admin);
            await expect(sb.write.updateConfig([999n, sideBetConfig()], { account: admin.account })).to.be.rejected;
            await sb.write.addConfig([sideBetConfig()], { account: admin.account });
            const configId = (await sb.read.configCount()) - 1n;
            await expect(
                sb.write.setConfigStakeLimits([configId, 0n, USDC("10")], { account: admin.account }),
            ).to.be.rejected;
            await expect(
                sb.write.setConfigStakeLimits([configId, USDC("10"), USDC("1")], { account: admin.account }),
            ).to.be.rejected;
            await sb.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });
            await sb.write.setMultiplierBand([60_000, 4_000_000], { account: admin.account });

            const empty = await sb.read.previewSettleBundle([0n, 0, 0, 1]);
            expect(empty[0].length).to.equal(0);
            const badLane = await sb.read.previewSettleBundle([0n, 10, 99, 1]);
            expect(badLane[0].length).to.equal(0);

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sb.write.placeBet([configId, USDC("10")], { account: alice.account });
            expect(await sb.read.isResolvable([0n])).to.equal(false);

            const settlementRole = await sb.read.SETTLEMENT_ROLE();
            await sb.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await sb.write.settleBatch([[{ betId: 999n, won: true, payoutAmount: 1n }], []], {
                account: admin.account,
            });
            const betBefore = await sb.read.getBet([0n]);
            await sb.write.settleBatch([[{ betId: 0n, won: true, payoutAmount: 1n }], []], { account: admin.account });
            expect((await sb.read.getBet([0n])).status).to.equal(betBefore.status); // still ACTIVE — wrong payout

            await re.write.fulfillRounds([[8]]);
            await sb.write.settleBatch([[{ betId: 0n, won: false, payoutAmount: 0n }], []], { account: admin.account });
            expect(await sb.read.isResolvable([0n])).to.equal(false);

            const v2 = await viem.deployContract("SideBet");
            await sb.write.upgradeToAndCall([v2.address, "0x"], { account: admin.account });
        });
    });
});

function sideBetConfig() {
    return {
        marketId: 1,
        betType: 1,
        color: 0,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 1,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
    };
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

async function deployEngineLibs() {
    const rouletteBetLib = await viem.deployContract("RouletteBetLib");
    const rouletteLib = await viem.deployContract("RouletteLib");
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib");
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib");
    const rouletteExposureLib = await viem.deployContract("RouletteExposureLib");
    const rouletteUpkeepScanLib = await viem.deployContract("RouletteUpkeepScanLib");
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
        "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib": rouletteUpkeepScanLib.address,
    };
}
