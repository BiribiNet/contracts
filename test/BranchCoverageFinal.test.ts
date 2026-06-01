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

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { laneCheckData } from "./helpers/parallelUpkeep";

const USDC = (v: string) => parseUnits(v, 6);

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

describe("Branch coverage — final gaps", function () {
    describe("RouletteEngine initialize OR-matrix", function () {
        it("reverts initialize on each zero init field", async function () {
            const vrf = await viem.deployContract("MockVrfCoordinator");
            const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
            const impl = await viem.deployContract(
                "RouletteEngine",
                [vrf.address, mockLaneKey, mockLaneKey, mockLaneKey, 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );

            const cases = [
                { registry: zeroAddress },
                { jackpotTreasury: zeroAddress },
                { jackpotFunder: zeroAddress },
                { infraRecipient: zeroAddress },
                { admin: zeroAddress },
                { upkeepScheduler: zeroAddress },
                { roundDuration: 0 },
            ] as const;

            for (const patch of cases) {
                const init = encodeFunctionData({
                    abi: impl.abi,
                    functionName: "initialize",
                    args: [engineInitCfg(patch)],
                });
                await expect(viem.deployContract("ERC1967Proxy", [impl.address, init])).to.be.rejected;
            }
        });
    });

    describe("RouletteEngine admin + bet validation", function () {
        it("covers admin setters, invalid bets, upgrade, and empty registry scan", async function () {
            const [admin, alice, stranger] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, router } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            const payoutRole = await engine.read.ENGINE_PAYOUT_ROLE();
            const roundRole = await engine.read.ENGINE_ROUND_ROLE();
            await engine.write.grantRole([withdrawalRole, admin.account.address], { account: admin.account });
            await engine.write.grantRole([payoutRole, admin.account.address], { account: admin.account });
            await engine.write.grantRole([roundRole, admin.account.address], { account: admin.account });

            await engine.write.setWithdrawalQueueBatchSize([5], { account: admin.account });
            await engine.write.setMaxWithdrawalQueueLength([50], { account: admin.account });
            await engine.write.setPayoutLaneCount([2], { account: admin.account });
            await engine.write.setRoundDuration([600], { account: admin.account });
            expect(await engine.read.payoutParallelLaneCount()).to.equal(2n);

            const v2 = await viem.deployContract("RouletteEngine", [vrf.address, ...laneKeys(), 1, zeroAddress], {
                libraries: await deployEngineLibs(),
            });
            await engine.write.upgradeToAndCall([v2.address, "0x"], { account: admin.account });

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });

            await expect(
                bank.write.placeBet([USDC("5"), encodeSingleBet(99n, 7n, USDC("5")), zeroAddress], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            const badSum = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[1n], [7n], [USDC("5"), USDC("6")]],
            );
            await expect(
                bank.write.placeBet([USDC("5"), badSum, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            await expect(
                bank.write.placeBet([USDC("5"), "0x" as Hex, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            await expect(
                engine.write.registerMarketFromRegistry([1, bank.address], { account: stranger.account }),
            ).to.be.rejected;

            const [found] = await engine.read.findNextJob([0, 10, 99, 1]);
            expect(found).to.equal(false);
        });
    });

    describe("BRBJackpotFunder admin happy paths", function () {
        it("covers setter success and treasury transfer ok branch", async function () {
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

            await funder.write.setSwapAssetBps([300], { account: admin.account });
            await funder.write.setTreasuryBrbSplit([250, 300], { account: admin.account });
            await funder.write.setSlippageBps([100], { account: admin.account });

            await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            expect(await treasury.read.jackpotPool()).to.be.gt(0n);
        });
    });

    describe("BankVault4626 remaining branches", function () {
        it("covers resolution block, engine-only release, and paid withdrawal", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const restricted = await viem.deployContract("MockEngineRestricted");
            const usdc = await viem.deployContract("MockUSDC");
            const sideBetAddr = admin.account.address;
            const impl = await viem.deployContract("BankVault4626");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: restricted.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: sideBetAddr,
                    },
                ],
            });
            const vault = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address,
            );

            await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
            await expect(vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account })).to
                .be.rejected;

            const mockEngine = await viem.deployContract("MockEngine");
            const init2 = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank2",
                        symbol: "b2",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: zeroAddress,
                    },
                ],
            });
            const vault2 = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [impl.address, init2])).address,
            );

            await usdc.write.mint([alice.account.address, parseUnits("200", 6)]);
            await usdc.write.approve([vault2.address, parseUnits("200", 6)], { account: alice.account });
            await vault2.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });
            await vault2.write.redeemBps([5000, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await mockEngine.write.processWithdrawals([vault2.address, 1n]);
            expect(await usdc.read.balanceOf([alice.account.address])).to.be.gt(0n);

            await mockEngine.write.releaseFromVault([vault2.address, parseUnits("1", 6)]);
        });
    });

    describe("SideBet views and config admin", function () {
        it("covers updateConfig, getConfig reverts, and settle row guards", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const { usdc, roundEngine, sideBet, bank } = await deploySideBetStack(admin);

            await expect(sideBet.read.getConfig([999n])).to.be.rejected;
            expect(await sideBet.read.isConfigActive([999n])).to.equal(false);

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

            await sideBet.write.removeConfig([configId], { account: admin.account });
            await expect(sideBet.read.getConfig([configId])).to.be.rejected;

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
            const activeId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([activeId, USDC("1"), USDC("1000")], { account: admin.account });

            await sideBet.write.updateConfig(
                [
                    activeId,
                    {
                        marketId: 1,
                        betType: 1,
                        color: 0,
                        targetNumber: 8,
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
            expect((await sideBet.read.getConfig([activeId])).targetNumber).to.equal(8);

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([activeId, USDC("10")], { account: alice.account });

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await roundEngine.write.fulfillRounds([[8]]);
            await sideBet.write.settleBatch(
                [[{ betId: 0n, won: true, payoutAmount: (await sideBet.read.getBet([0n])).payout }], []],
                { account: admin.account },
            );
        });
    });

    describe("LPVestingLock partial release", function () {
        it("covers release(address,uint256) overload", async function () {
            const [admin, beneficiary] = await viem.getWalletClients();
            const lp = await viem.deployContract("MockUSDC");
            const lock = await viem.deployContract("LPVestingLock", [
                lp.address,
                beneficiary.account.address,
                admin.account.address,
            ]);
            await lp.write.mint([lock.address, parseUnits("20", 6)]);
            await time.increase(3 * 365 * 24 * 60 * 60 + 1);
            await lock.write.release([beneficiary.account.address, parseUnits("7", 6)], {
                account: beneficiary.account,
            });
            expect(await lp.read.balanceOf([beneficiary.account.address])).to.equal(parseUnits("7", 6));
        });
    });

    describe("UpkeepScheduler SideBet performUpkeep", function () {
        it("executes SideBet settlement path", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const { usdc, roundEngine, sideBet, bank } = await deploySideBetStack(admin);
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

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
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

    describe("ProtocolTimelock execute + cancel", function () {
        it("covers successful execute and cancel", async function () {
            const [admin, proposer, executor] = await viem.getWalletClients();
            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            const callee = await viem.deployContract("MockTimelockCallee");
            const salt = 42n;
            const value = parseUnits("1", 18);
            await timelock.write.queue([callee.address, value, "0x", salt], { account: proposer.account });
            await time.increase(24 * 3600 + 1);
            await timelock.write.execute([callee.address, value, "0x", salt], {
                account: executor.account,
                value,
            });
            await timelock.write.queue([callee.address, 0n, "0x", salt + 1n], { account: proposer.account });
            const id2 = await timelock.read.operationId([callee.address, 0n, "0x", salt + 1n]);
            await timelock.write.cancel([id2], { account: admin.account });
        });
    });
});

function laneKeys(): [`0x${string}`, `0x${string}`, `0x${string}`] {
    const k = ("0x" + "11".repeat(32)) as `0x${string}`;
    return [k, k, k];
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
    return { usdc, roundEngine, sideBet, bank, registry };
}
