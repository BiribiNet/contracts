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

const USDC = (v: string) => parseUnits(v, 6);

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

function sideCfg(overrides: Record<string, unknown> = {}) {
    return {
        marketId: 1,
        betType: BetType.NUMBER_HIT,
        color: 0,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

async function deploySideBetFixture() {
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
    await usdc.write.mint([admin.account.address, USDC("10000")]);
    await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
    await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
    return { admin, alice, usdc, roundEngine, sideBet, bank };
}

describe("Branch coverage — remainder matrix", function () {
    describe("SideBet _validateConfigCore per bet type", function () {
        it("reverts invalid configs and accepts valid templates for every bet type", async function () {
            const { admin, sideBet } = await deploySideBetFixture();

            const invalidCases: Record<string, unknown>[] = [
                { marketId: 0 },
                { windowSpins: 0 },
                { multiplierBps: 10_000 },
                { multiplierBps: 10_000_000 },
                { betType: BetType.NUMBER_HIT, targetNumber: 38 },
                { betType: BetType.NUMBER_HIT, targetCount: 0 },
                { betType: BetType.NUMBER_HIT, targetCount: 5, windowSpins: 3 },
                { betType: BetType.COLOR_COUNT, targetCount: 0 },
                { betType: BetType.CONSECUTIVE_STREAK, targetCount: 0 },
                { betType: BetType.RED_RATIO, redRatioBps: 0 },
                { betType: BetType.RED_RATIO, redRatioBps: 10_001 },
                { betType: BetType.LIGHTNING_DOUBLE, targetNumber: 38 },
                { betType: BetType.LIGHTNING_DOUBLE, targetCount: 1, windowSpins: 3 },
                { betType: BetType.PERFECT_ALTERNATION, windowSpins: 1 },
                { betType: BetType.DOZEN_HIT, targetNumber: 0 },
                { betType: BetType.COLUMN_HIT, targetCount: 0 },
            ];
            for (const patch of invalidCases) {
                await expect(
                    sideBet.write.addConfig([sideCfg(patch)], { account: admin.account }),
                ).to.be.rejected;
            }

            const validCases: Record<string, unknown>[] = [
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
            for (const patch of validCases) {
                await sideBet.write.addConfig([sideCfg(patch)], { account: admin.account });
                const id = (await sideBet.read.configCount()) - 1n;
                await sideBet.write.setConfigStakeLimits([id, USDC("1"), USDC("1000")], { account: admin.account });
            }

            await sideBet.write.setMultiplierBand([60_000, 4_000_000], { account: admin.account });
            const id0 = 0n;
            await sideBet.write.updateConfig(
                [id0, sideCfg({ betType: BetType.NUMBER_HIT, targetNumber: 8, targetCount: 1, windowSpins: 3 })],
                { account: admin.account },
            );
            expect((await sideBet.read.getConfig([id0])).targetNumber).to.equal(8);

            await expect(
                sideBet.write.setConfigStakeLimits([999n, USDC("1"), USDC("2")], { account: admin.account }),
            ).to.be.rejected;
            await sideBet.write.removeConfig([id0], { account: admin.account });
            await expect(sideBet.read.getConfig([id0])).to.be.rejected;
            await expect(
                sideBet.write.setConfigStakeLimits([id0, USDC("1"), USDC("2")], { account: admin.account }),
            ).to.be.rejected;
        });

        it("initialize reverts on zero addresses and invalid multiplier band", async function () {
            const [admin] = await viem.getWalletClients();
            const impl = await viem.deployContract("SideBet");
            const badInits: [Address, Address, Address, number, number][] = [
                [zeroAddress, admin.account.address, admin.account.address, 50_000, 5_000_000],
                [admin.account.address, zeroAddress, admin.account.address, 50_000, 5_000_000],
                [admin.account.address, admin.account.address, zeroAddress, 50_000, 5_000_000],
                [admin.account.address, admin.account.address, admin.account.address, 50_000, 40_000],
                [admin.account.address, admin.account.address, admin.account.address, 100_000, 50_000],
            ];
            for (const args of badInits) {
                const init = encodeFunctionData({ abi: impl.abi, functionName: "initialize", args });
                await expect(viem.deployContract("ERC1967Proxy", [impl.address, init])).to.be.rejected;
            }
        });

        it("covers placeBet reverts, preview guards, views, and upgrade", async function () {
            const { admin, alice, sideBet, bank, roundEngine, usdc } = await deploySideBetFixture();

            expect(await sideBet.read.minMultiplierBps()).to.equal(50_000);
            expect(await sideBet.read.maxMultiplierBps()).to.equal(5_000_000);
            expect(await sideBet.read.isResolvable([999n])).to.equal(false);

            await expect(sideBet.write.placeBet([999n, USDC("10")], { account: alice.account })).to.be.rejected;

            await sideBet.write.addConfig([sideCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await expect(sideBet.write.placeBet([configId, USDC("10")], { account: alice.account })).to.be.rejected;

            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });
            await expect(sideBet.write.placeBet([configId, USDC("0.5")], { account: alice.account })).to.be.rejected;
            await expect(sideBet.write.placeBet([configId, USDC("200")], { account: alice.account })).to.be.rejected;

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            expect(await sideBet.read.isResolvable([0n])).to.equal(false);

            const emptyPreview = await sideBet.read.previewSettleBundle([0n, 0, 0, 1]);
            expect(emptyPreview[0].length).to.equal(0);
            const badLane = await sideBet.read.previewSettleBundle([0n, 10, 99, 1]);
            expect(badLane[0].length).to.equal(0);

            await roundEngine.write.fulfillRounds([[8]]);
            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            await sideBet.write.settleBatch(
                [[{ betId: 0n, won: false, payoutAmount: 0n }], []],
                { account: admin.account },
            );

            const v2 = await viem.deployContract("SideBet");
            await sideBet.write.upgradeToAndCall([v2.address, "0x"], { account: admin.account });
        });
    });

    describe("RouletteEngine view and admin branches", function () {
        it("covers findNextJob guards, preview early returns, and setter bounds", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf } = stack;

            const [foundZeroMarkets] = await engine.read.findNextJob([0, 25, 0, 0]);
            expect(foundZeroMarkets).to.equal(false);

            const [foundShardWidth] = await engine.read.findNextJob([0, 25, 0, 10]);
            expect(foundShardWidth).to.equal(false);

            const [foundHighLane] = await engine.read.findNextJob([0, 25, 99, 0]);
            expect(foundHighLane).to.equal(false);

            const emptyPreview = await engine.read.previewPayoutBundle([
                { kind: 0, marketId: 1, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 },
                10,
            ]);
            expect(emptyPreview[0].length).to.equal(0);

            expect(
                await engine.read.payoutLaneHasWork([
                    { kind: 0, marketId: 1, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 },
                ]),
            ).to.equal(false);

            const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
            await engine.write.grantRole([withdrawalRole, admin.account.address], { account: admin.account });
            await expect(engine.write.setWithdrawalQueueBatchSize([0], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setWithdrawalQueueBatchSize([21], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setMaxWithdrawalQueueLength([0], { account: admin.account })).to.be.rejected;
            await expect(engine.write.setMaxWithdrawalQueueLength([1001], { account: admin.account })).to.be.rejected;
            await engine.write.setWithdrawalQueueBatchSize([10], { account: admin.account });
            await engine.write.setMaxWithdrawalQueueLength([200], { account: admin.account });

            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("3000")]);
            await usdc.write.approve([bank.address, USDC("3000")], { account: admin.account });
            await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });

            const bob = (await viem.getWalletClients())[2];
            await expect(
                bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), alice.account.address], {
                    account: alice.account,
                }),
            ).to.be.rejected;
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), bob.account.address], {
                account: alice.account,
            });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            expect(await bank.read.maxWithdraw([admin.account.address])).to.be.lte(USDC("1000"));
            expect(await bank.read.maxRedeem([admin.account.address])).to.be.gt(0n);

            await vrf.write.fulfill([engine.address, 1n, 7n]);
            while (true) {
                const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
                if (!needed) break;
                await scheduler.write.performUpkeep([data]);
            }
        });
    });

    describe("UpkeepScheduler admin happy paths", function () {
        it("updates scan limit and max payouts per call", async function () {
            const { scheduler, admin } = await deployProtocolStack();
            await scheduler.write.setScanLimit([64], { account: admin });
            await scheduler.write.setMaxPayoutsPerCall([8], { account: admin });
            expect(await scheduler.read.scanLimit()).to.equal(64);
            expect(await scheduler.read.maxPayoutsPerCall()).to.equal(8);
        });
    });

    describe("BRBJackpotFunder setter happy paths and swap burn", function () {
        it("covers admin setters and successful swap split", async function () {
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
            await funder.write.setTreasuryBrbSplit([25, 100], { account: admin.account });
            await funder.write.setSlippageBps([50], { account: admin.account });

            await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
            const poolBefore = await treasury.read.jackpotPool();
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            expect(await treasury.read.jackpotPool()).to.be.gt(poolBefore);
        });
    });

    describe("BankVault4626 modifier and queue branches", function () {
        it("covers transferOut onlyEngine, redeemBps guards, and partial payout", async function () {
            const [admin, alice, bob, stranger] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
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
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: zeroAddress,
                    },
                ],
            });
            const vault = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address,
            );

            await expect(
                vault.write.transferOut([alice.account.address, 1n], { account: stranger.account }),
            ).to.be.rejected;
            await usdc.write.mint([vault.address, USDC("10")]);
            await mockEngine.write.transferOutFromVault([vault.address, alice.account.address, USDC("1")]);
            expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("1"));

            await expect(vault.write.redeemBps([0, alice.account.address, alice.account.address], { account: alice.account })).to
                .be.rejected;
            await expect(
                vault.write.redeemBps([10_001, alice.account.address, alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await expect(
                vault.write.redeemBps([100, zeroAddress, alice.account.address], { account: alice.account }),
            ).to.be.rejected;

            const fee = await vault.read.flatWithdrawFee();
            await usdc.write.mint([bob.account.address, fee * 3n]);
            await usdc.write.approve([vault.address, fee * 3n], { account: bob.account });
            await vault.write.deposit([fee * 3n, bob.account.address], { account: bob.account });
            await vault.write.redeemBps([10_000, bob.account.address, bob.account.address], { account: bob.account });
            await mockEngine.write.transferOutFromVault([
                vault.address,
                admin.account.address,
                await usdc.read.balanceOf([vault.address]),
            ]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
        });
    });
});
