import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, getAddress, parseUnits } from "viem";

import { predictSideBetProxyAddress } from "../scripts/utils/predictDeployAddresses";

import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";

const MIN_MULTIPLIER_BPS = 50_000; // 5x
const MAX_MULTIPLIER_BPS = 5_000_000; // 500x
const INFRA_BPS = 200n;
const SW_BPS_DENOM = 10_000n;
const ROUTER_BRB_LIQUIDITY = parseUnits("2000000", 18);

const USDC = (value: string): bigint => parseUnits(value, 6);

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
const ANY_NUMBER = 37;
const Color = { RED: 0, BLACK: 1 } as const;
const Status = { ACTIVE: 0, WON: 1, LOST: 2, EXPIRED: 3, CANCELLED: 4 } as const;

const MARKET_ID = 1;

type ConfigInput = {
    marketId: number;
    betType: number;
    color: number;
    targetNumber: number;
    targetCount: number;
    redRatioBps: number;
    windowSpins: number;
    multiplierBps: number;
    minStake: bigint;
    maxStake: bigint;
};

function config(overrides: Partial<ConfigInput> = {}): ConfigInput {
    return {
        marketId: MARKET_ID,
        betType: BetType.NUMBER_HIT,
        color: Color.RED,
        targetNumber: 0,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000, // 10x
        minStake: USDC("1"),
        maxStake: USDC("1000"),
        ...overrides,
    };
}

/** Registers a config template and activates stake limits (split roles on-chain). */
async function registerConfig(
    sideBet: Awaited<ReturnType<typeof deployFixture>>["sideBet"],
    cfg: ConfigInput,
    account: { address: `0x${string}` },
) {
    const { minStake, maxStake, ...template } = cfg;
    await sideBet.write.addConfig([{ ...template, minStake: 0n, maxStake: 0n }], { account });
    const configId = (await sideBet.read.configCount()) - 1n;
    await sideBet.write.setConfigStakeLimits([configId, minStake, maxStake], { account });
    return configId;
}

type SchedulerContract = Awaited<ReturnType<typeof viem.deployContract<"UpkeepScheduler">>>;

async function settleViaScheduler(scheduler: SchedulerContract) {
    const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
    expect(performData).to.not.equal("0x");
    await scheduler.write.performUpkeep([performData]);
}

async function deployFixture() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

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
        minMultiplierBps: MIN_MULTIPLIER_BPS,
        maxMultiplierBps: MAX_MULTIPLIER_BPS,
    });
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    const scheduler = await viem.deployContract("UpkeepScheduler", [
        roundEngine.address,
        sideBet.address,
        admin.account.address,
        32,
        32,
    ]);
    const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
    await sideBet.write.grantRole([settlementRole, scheduler.address], { account: admin.account });
    await wireTestSchedulerForwarder(scheduler, admin.account);

    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
        { account: admin.account },
    );
    const market = await registry.read.getMarket([MARKET_ID]);
    const vault = await viem.getContractAt("BankVault4626", market.bank);
    expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(sideBet.address));

    // LP liquidity in the vault.
    await usdc.write.mint([admin.account.address, USDC("10000")]);
    await usdc.write.approve([vault.address, USDC("10000")], { account: admin.account });
    await vault.write.deposit([USDC("10000"), admin.account.address], { account: admin.account });

    await usdc.write.mint([alice.account.address, USDC("1000")]);
    await usdc.write.approve([vault.address, USDC("1000")], { account: alice.account });

    return { sideBet, scheduler, vault, usdc, registry, roundEngine, admin, alice, bob, publicClient };
}

async function fulfillRounds(
    roundEngine: { write: { fulfillRounds: (a: [number[]]) => Promise<unknown> } },
    numbers: number[],
) {
    await roundEngine.write.fulfillRounds([numbers]);
}

async function fulfillRoundsWithJackpot(
    roundEngine: {
        write: { fulfillRoundsWithJackpot: (a: [number[], boolean[]]) => Promise<unknown> };
    },
    numbers: number[],
    jackpots: boolean[],
) {
    await roundEngine.write.fulfillRoundsWithJackpot([numbers, jackpots]);
}

describe("SideBet", function () {
    it("initializes the multiplier band", async function () {
        const { sideBet } = await deployFixture();
        expect(await sideBet.read.minMultiplierBps()).to.equal(MIN_MULTIPLIER_BPS);
        expect(await sideBet.read.maxMultiplierBps()).to.equal(MAX_MULTIPLIER_BPS);
    });

    it("settles a NUMBER_HIT win and pays the player + reserves liability while active", async function () {
        const { sideBet, scheduler, usdc, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(sideBet, config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }), admin.account);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("100"));
        expect(await sideBet.read.isResolvable([0n])).to.equal(false);

        await fulfillRounds(roundEngine, [2, 7, 4]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);

        await settleViaScheduler(scheduler);

        const bet = await sideBet.read.getBet([0n]);
        expect(bet.status).to.equal(Status.WON);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("1090"));
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
    });

    it("settles a NUMBER_HIT loss, keeping the stake in the vault", async function () {
        const { sideBet, scheduler, vault, usdc, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(sideBet, config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }), admin.account);
        const vaultBalBefore = await usdc.read.balanceOf([vault.address]);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [2, 4, 6]);

        await settleViaScheduler(scheduler);
        const bet = await sideBet.read.getBet([0n]);
        expect(bet.status).to.equal(Status.LOST);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("990"));
        expect(await usdc.read.balanceOf([vault.address])).to.equal(vaultBalBefore + USDC("10"));
    });

    it("rejects placeBet once the start round's VRF is already fulfilled (C-1)", async function () {
        const { sideBet, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 }),
            admin.account,
        );

        // Positive control: while the start round is still open, the bet is accepted.
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.ACTIVE);

        // Reproduce the settling window: the current round's outcome is public but the
        // global-round pointer has not advanced yet. Placing now would be risk-free.
        await roundEngine.write.markCurrentRoundFulfilled([7], { account: admin.account });
        await expect(sideBet.write.placeBet([0n, USDC("10")], { account: alice.account })).to.be.rejected;
    });

    it("wins COLOR_COUNT early and loses on a fully-observed window", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.COLOR_COUNT, color: Color.RED, targetCount: 2, windowSpins: 4, multiplierBps: 50_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 3]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [2, 4, 6, 0]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("wins CONSECUTIVE_STREAK early and loses when the streak breaks", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.CONSECUTIVE_STREAK, color: Color.RED, targetCount: 3, windowSpins: 5, multiplierBps: 60_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 3, 5]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 2, 1, 2, 1]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("settles RED_RATIO (early win, early loss)", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.RED_RATIO, redRatioBps: 6000, windowSpins: 5, multiplierBps: 50_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 3, 5]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [2, 4, 6]);
        expect(await sideBet.read.isResolvable([1n])).to.equal(true);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("reverts placing a bet the vault cannot cover", async function () {
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
            minMultiplierBps: MIN_MULTIPLIER_BPS,
            maxMultiplierBps: MAX_MULTIPLIER_BPS,
        });
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );
        const market = await registry.read.getMarket([MARKET_ID]);
        const vault = await viem.getContractAt("BankVault4626", market.bank);
        await usdc.write.mint([admin.account.address, USDC("100")]);
        await usdc.write.approve([vault.address, USDC("100")], { account: admin.account });
        await vault.write.deposit([USDC("15"), admin.account.address], { account: admin.account });
        await usdc.write.mint([alice.account.address, USDC("100")]);
        await usdc.write.approve([vault.address, USDC("100")], { account: alice.account });
        await registerConfig(sideBet, config({ multiplierBps: 100_000 }), admin.account);
        await expect(sideBet.write.placeBet([0n, USDC("10")], { account: alice.account })).to.be.rejected;
    });

    it("reverts settling before the outcome is decided, and is idempotent after", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(sideBet, config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }), admin.account);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await expect(
            sideBet.write.settleBatch([[{ betId: 0n, won: true, payoutAmount: USDC("100"), expired: false }], []], { account: alice.account }),
        ).to.be.rejected;

        const [, performDataBefore] = await scheduler.read.checkUpkeep(["0x"]);
        expect(performDataBefore).to.equal("0x");

        await fulfillRounds(roundEngine, [7, 1, 2]);
        await settleViaScheduler(scheduler);
        await expect(
            sideBet.write.settleBatch([[{ betId: 0n, won: true, payoutAmount: USDC("100"), expired: false }], []], { account: admin.account }),
        ).to.be.rejected;
    });

    it("removes a config and blocks new bets while existing bets still settle", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        const configId = await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }),
            admin.account,
        );
        await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });

        await sideBet.write.removeConfig([configId], { account: admin.account });
        expect(await sideBet.read.isConfigActive([configId])).to.equal(false);
        await expect(sideBet.read.getConfig([configId])).to.be.rejected;
        await expect(sideBet.write.placeBet([configId, USDC("10")], { account: alice.account })).to.be.rejected;
        await expect(sideBet.write.removeConfig([configId], { account: admin.account })).to.be.rejected;
        await expect(sideBet.write.updateConfig([configId, config()], { account: admin.account })).to.be.rejected;

        await fulfillRounds(roundEngine, [7, 1, 2]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });

    it("enforces access control on configs and stake limits", async function () {
        const { sideBet, alice, admin } = await deployFixture();
        await expect(sideBet.write.addConfig([config()], { account: alice.account })).to.be.rejected;
        await expect(sideBet.write.removeConfig([0n], { account: alice.account })).to.be.rejected;
        await sideBet.write.addConfig([{ ...config(), minStake: 0n, maxStake: 0n }], { account: admin.account });
        const configId = (await sideBet.read.configCount()) - 1n;
        await expect(
            sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("1000")], { account: alice.account }),
        ).to.be.rejected;
        await expect(sideBet.write.placeBet([configId, USDC("10")], { account: alice.account })).to.be.rejected;
    });

    it("rejects a multiplier outside the configured band and invalid params", async function () {
        const { sideBet, admin } = await deployFixture();
        await expect(sideBet.write.addConfig([config({ multiplierBps: 30_000 })], { account: admin.account })).to.be.rejected;
        await expect(sideBet.write.addConfig([config({ windowSpins: 0 })], { account: admin.account })).to.be.rejected;
    });

    it("settles LIGHTNING_DOUBLE at >100x odds", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({
                betType: BetType.LIGHTNING_DOUBLE,
                targetNumber: ANY_NUMBER,
                targetCount: 2,
                windowSpins: 6,
                multiplierBps: 1_500_000,
            }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("1500"));

        await fulfillRounds(roundEngine, [5, 5]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });

    it("settles PERFECT_ALTERNATION", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.PERFECT_ALTERNATION, windowSpins: 4, multiplierBps: 50_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 2, 1, 2]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 3]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("settles DOZEN_HIT and COLUMN_HIT", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 3, windowSpins: 5, multiplierBps: 50_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 2, 3]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await registerConfig(
            sideBet,
            config({ betType: BetType.COLUMN_HIT, targetNumber: 1, targetCount: 2, windowSpins: 4, multiplierBps: 50_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([1n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [1, 4]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.WON);
    });

    it("settles JACKPOT_IN_WINDOW (early win and full-window loss)", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.JACKPOT_IN_WINDOW, windowSpins: 5, multiplierBps: 200_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.isResolvable([0n])).to.equal(false);

        await fulfillRoundsWithJackpot(roundEngine, [1, 2], [false, true]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRoundsWithJackpot(roundEngine, [3, 4, 5, 6, 7], [false, false, false, false, false]);
        await settleViaScheduler(scheduler);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("settles a batch via UpkeepScheduler", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();

        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 2 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [7, 1]);

        const [, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(performData).to.not.equal("0x");
        await scheduler.write.performUpkeep([performData]);
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });

    it("updates config, multiplier band, and player index views", async function () {
        const { sideBet, admin, alice } = await deployFixture();
        await registerConfig(sideBet, config({ targetNumber: 3 }), admin.account);
        await sideBet.write.updateConfig([0n, config({ targetNumber: 5 })], { account: admin.account });
        const cfg = await sideBet.read.getConfig([0n]);
        expect(cfg.targetNumber).to.equal(5);

        await sideBet.write.setMultiplierBand([60_000, 4_000_000], { account: admin.account });
        expect(await sideBet.read.minMultiplierBps()).to.equal(60_000);
        expect(await sideBet.read.maxMultiplierBps()).to.equal(4_000_000);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.betCount()).to.equal(1n);
        expect(await sideBet.read.playerBetCount([alice.account.address])).to.equal(1n);
        expect(await sideBet.read.playerBetAt([alice.account.address, 0n])).to.equal(0n);
        expect(await sideBet.read.availableVaultLiquidity([MARKET_ID])).to.be.gt(0n);
        expect(await sideBet.read.isResolvable([99n])).to.equal(false);

        const preview = await sideBet.read.previewSettleBundle([0n, 0, 0, 1]);
        expect(preview[0].length).to.equal(0);
    });

    it("ignores invalid settle rows in settleBatch", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(sideBet, config({ betType: BetType.NUMBER_HIT, targetNumber: 7, windowSpins: 1 }), admin.account);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [7]);

        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
        await sideBet.write.settleBatch(
            [[{ betId: 0n, won: true, payoutAmount: USDC("1"), expired: false }], []],
            { account: admin.account },
        );
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.ACTIVE);

        await sideBet.write.settleBatch(
            [[{ betId: 0n, won: false, payoutAmount: USDC("1"), expired: false }], []],
            { account: admin.account },
        );
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.ACTIVE);

        await sideBet.write.settleBatch(
            [[{ betId: 0n, won: true, payoutAmount: USDC("100"), expired: false }], []],
            { account: admin.account },
        );
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });

    it("settles bets across two markets in one batch", async function () {
        const { sideBet, scheduler, usdc, registry, admin, alice, roundEngine } = await deployFixture();

        const usdc2 = await viem.deployContract("MockUSDC");
        await registry.write.createMarket(
            [{ asset: usdc2.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );
        const market2 = await registry.read.getMarket([2]);
        const vault2 = await viem.getContractAt("BankVault4626", market2.bank);
        await usdc2.write.mint([admin.account.address, USDC("10000")]);
        await usdc2.write.mint([alice.account.address, USDC("1000")]);
        await usdc2.write.approve([vault2.address, USDC("1000")], { account: alice.account });
        await usdc2.write.approve([vault2.address, USDC("5000")], { account: admin.account });
        await vault2.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });

        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 }),
            admin.account,
        );
        await registerConfig(
            sideBet,
            config({ marketId: 2, betType: BetType.NUMBER_HIT, targetNumber: 5, targetCount: 1, windowSpins: 1 }),
            admin.account,
        );

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [7]);
        await sideBet.write.placeBet([1n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [5]);
        await settleViaScheduler(scheduler);

        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.WON);
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
        expect(await sideBet.read.reservedOf([2])).to.equal(0n);
    });

    it("pays every winner when two markets have interleaved winners in one batch (NEW-1)", async function () {
        const { sideBet, scheduler, usdc, registry, admin, alice, roundEngine } = await deployFixture();

        // Second market (vault index 1). Market 1 (usdc) is vault index 0.
        const usdc2 = await viem.deployContract("MockUSDC");
        await registry.write.createMarket(
            [{ asset: usdc2.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );
        const market2 = await registry.read.getMarket([2]);
        const vault2 = await viem.getContractAt("BankVault4626", market2.bank);
        await usdc2.write.mint([admin.account.address, USDC("10000")]);
        await usdc2.write.mint([alice.account.address, USDC("1000")]);
        await usdc2.write.approve([vault2.address, USDC("1000")], { account: alice.account });
        await usdc2.write.approve([vault2.address, USDC("5000")], { account: admin.account });
        await vault2.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });

        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 }),
            admin.account,
        ); // configId 0 → market 1
        await registerConfig(
            sideBet,
            config({ marketId: 2, betType: BetType.NUMBER_HIT, targetNumber: 5, targetCount: 1, windowSpins: 1 }),
            admin.account,
        ); // configId 1 → market 2

        // betId order across vaults must be [market1, market2, market1] → vault indices [0, 1, 0].
        // Pre-fix, the third winner (market1) overwrote the second winner's (market2) payout slot,
        // so vault 2 paid address(0)/0 and its winner was never paid.
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account }); // betId 0, market 1
        await fulfillRounds(roundEngine, [7]);
        await sideBet.write.placeBet([1n, USDC("10")], { account: alice.account }); // betId 1, market 2
        await fulfillRounds(roundEngine, [5]);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account }); // betId 2, market 1
        await fulfillRounds(roundEngine, [7]);

        await settleViaScheduler(scheduler);

        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.WON);
        expect((await sideBet.read.getBet([2n])).status).to.equal(Status.WON);

        // Market 2 winner (betId 1) must actually be paid: 10 staked → 990, +100 payout → 1090.
        expect(await usdc2.read.balanceOf([alice.account.address])).to.equal(USDC("1090"));
        // Market 1 winners (betId 0 & 2): 1000 − 20 staked + 200 payout → 1180.
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("1180"));
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
        expect(await sideBet.read.reservedOf([2])).to.equal(0n);
    });

    it("realigns the lane cursor without unsigned underflow when id % laneCount > lane (NEW-3)", async function () {
        const { sideBet } = await deployFixture();
        // cursorBetId=3, lane=1, laneCount=5 → id % laneCount (3) > lane (1). Pre-fix, the realignment
        // `lane - (id % laneCount)` underflowed in unsigned math and reverted; it must now return cleanly,
        // advancing to the next id ≡ lane (mod laneCount) at or after the cursor (3 → 6).
        const preview = await sideBet.read.previewSettleBundle([3n, 10, 1, 5]);
        expect(preview[0].length).to.equal(0); // rows
        expect(preview[1]).to.equal(6n); // nextCursorBetId
    });

    it("ignores a replayed settle report instead of paying winners twice (C-2)", async function () {
        const { sideBet, vault, usdc, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }),
            admin.account,
        );

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [2, 7, 4]);

        // Capture the exact (rows, vaultApplies) blob a CRE report carries, then deliver it twice.
        const bundle = await sideBet.read.previewSettleBundle([0n, 10, 0, 1]);
        expect(bundle[0].length).to.be.gt(0);
        expect(bundle[2].length).to.be.gt(0);

        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });

        await sideBet.write.settleBatch([bundle[0], bundle[2]], { account: admin.account });

        const playerAfterFirst = await usdc.read.balanceOf([alice.account.address]);
        const vaultAfterFirst = await usdc.read.balanceOf([vault.address]);
        const lockedAfterFirst = await vault.read.lockedBetLiquidity();
        expect(playerAfterFirst).to.equal(USDC("1090"));
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);

        // Replay the identical report. Pre-fix this re-ran payoutBatch/releaseBets/fee collection,
        // paying the winner a second time out of LP liquidity.
        await sideBet.write.settleBatch([bundle[0], bundle[2]], { account: admin.account });

        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(playerAfterFirst);
        expect(await usdc.read.balanceOf([vault.address])).to.equal(vaultAfterFirst);
        expect(await vault.read.lockedBetLiquidity()).to.equal(lockedAfterFirst);
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
    });

    it("does not strand a still-undecided bet behind a settled one (H-3)", async function () {
        const { sideBet, scheduler, vault, usdc, admin, alice, bob, roundEngine } = await deployFixture();

        // Two configs in the same lane (MockRoundEngine reports laneCount == 1): A resolves after one
        // spin, B needs five.
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 }),
            admin.account,
        );
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 13, targetCount: 1, windowSpins: 5 }),
            admin.account,
        );

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await usdc.write.mint([bob.account.address, USDC("1000")], { account: admin.account });
        await usdc.write.approve([vault.address, USDC("1000")], { account: bob.account });
        await sideBet.write.placeBet([1n, USDC("10")], { account: bob.account });

        // One spin decides A but leaves B's window open.
        await fulfillRounds(roundEngine, [7]);
        await settleViaScheduler(scheduler);

        // The scan pointer runs to the end of the bet list, but the cursor must stop at the first
        // still-undecided bet. Persisting the scan pointer skipped B forever: its stake was never
        // returned and its payout reserve never released.
        expect(await scheduler.read.sideBetCursor([0n])).to.equal(1n);

        // B must still be reachable once its window fills.
        await fulfillRounds(roundEngine, [13, 1, 2, 3]);
        await settleViaScheduler(scheduler);

        expect(await vault.read.lockedBetLiquidity()).to.equal(0n);
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
    });

    it("expires an undecidable bet and refunds the stake (H-3)", async function () {
        const { sideBet, scheduler, vault, usdc, admin, alice } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 5 }),
            admin.account,
        );

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("100"));

        // No rounds are ever fulfilled. Rounds only advance when someone places a *roulette* bet, so
        // in a quiet market this bet can never be decided — and would hold its lane's cursor forever.
        await expect(settleViaScheduler(scheduler)).to.be.rejected;

        await time.increase(Number(await sideBet.read.settleTimeout()) + 1);
        await settleViaScheduler(scheduler);

        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.EXPIRED);
        // Stake returned in full, reserve released, and no fee taken on a bet that never resolved.
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(balanceBefore);
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
        expect(await vault.read.lockedBetLiquidity()).to.equal(0n);
    });

    it("rejects a forged expiry before the timeout elapses (H-3)", async function () {
        const { sideBet, admin, alice } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 5 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });

        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });

        // The report claims expiry; the contract re-derives it from storage and refuses.
        await sideBet.write.settleBatch(
            [[{ betId: 0n, won: false, payoutAmount: 0n, expired: true }], []],
            { account: admin.account },
        );
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.ACTIVE);
    });

    it("rejects a rewound or out-of-range settle cursor (H-3)", async function () {
        const { sideBet, scheduler, admin, alice, roundEngine } = await deployFixture();
        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await fulfillRounds(roundEngine, [7]);

        const SIDE_BET_KIND = 1;
        const encodeSideBetPerformData = (cursor: bigint) =>
            encodeAbiParameters(
                [
                    { type: "uint8" },
                    { type: "uint256" },
                    {
                        type: "tuple[]",
                        components: [
                            { name: "betId", type: "uint256" },
                            { name: "won", type: "bool" },
                            { name: "payoutAmount", type: "uint256" },
                            { name: "expired", type: "bool" },
                        ],
                    },
                    { type: "uint256" },
                    {
                        type: "tuple[]",
                        components: [
                            { name: "bank", type: "address" },
                            { name: "marketId", type: "uint32" },
                            { name: "releaseTotal", type: "uint256" },
                            { name: "totalStakes", type: "uint256" },
                            { name: "totalPaid", type: "uint256" },
                            {
                                name: "winnerPayouts",
                                type: "tuple[]",
                                components: [
                                    { name: "player", type: "address" },
                                    { name: "amount", type: "uint256" },
                                ],
                            },
                        ],
                    },
                ],
                [SIDE_BET_KIND, 0n, [], cursor, []],
            );

        // The cursor decides which bets are ever revisited, and it is the one report field written
        // verbatim. Overshooting betCount would skip bets that do not exist yet.
        const betCount = await sideBet.read.betCount();
        await expect(
            scheduler.write.performUpkeep([encodeSideBetPerformData(betCount + 100n)]),
        ).to.be.rejected;

        // Advance it legitimately, then try to rewind — that would re-settle already-handled bets.
        await settleViaScheduler(scheduler);
        const advanced = await scheduler.read.sideBetCursor([0n]);
        expect(advanced).to.be.gt(0n);
        await expect(scheduler.write.performUpkeep([encodeSideBetPerformData(0n)])).to.be.rejected;
        expect(await scheduler.read.sideBetCursor([0n])).to.equal(advanced);
    });

    it("supports UUPS upgrade by admin", async function () {
        const { sideBet, admin } = await deployFixture();
        const v2 = await viem.deployContract("SideBet");
        await sideBet.write.upgradeToAndCall([v2.address, "0x"], { account: admin.account });
        expect(await sideBet.read.minMultiplierBps()).to.equal(MIN_MULTIPLIER_BPS);
    });
});

describe("SideBet reserved-liquidity accounting", function () {
    it("keeps reservedOf constant-gas as the bet history grows", async function () {
        const { sideBet, admin, alice, publicClient } = await deployFixture();
        await registerConfig(sideBet, config({ multiplierBps: 100_000 }), admin.account);

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        const gasWithOneBet = await publicClient.estimateContractGas({
            address: sideBet.address,
            abi: sideBet.abi,
            functionName: "reservedOf",
            args: [MARKET_ID],
            account: alice.account,
        });

        for (let placed = 1; placed < 12; placed += 1) {
            await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        }

        const gasWithTwelveBets = await publicClient.estimateContractGas({
            address: sideBet.address,
            abi: sideBet.abi,
            functionName: "reservedOf",
            args: [MARKET_ID],
            account: alice.account,
        });

        // The old implementation scanned every bet ever placed: measured against it, this same
        // assertion reads 35_938 gas at one bet and 111_705 at twelve — about 6.9k per extra bet,
        // which walks into the RPC gas cap a few thousand bets in. Equality, not "close enough",
        // is what proves the scan is gone.
        expect(gasWithTwelveBets).to.equal(gasWithOneBet);
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("1200"));
    });

    it("drops a bet's reserve on settlement and leaves other markets untouched", async function () {
        const { sideBet, scheduler, registry, admin, alice, roundEngine } = await deployFixture();
        const secondMarketId = 2;
        const secondAsset = await viem.deployContract("MockUSDC");
        await registry.write.createMarket(
            [{ asset: secondAsset.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );
        const secondMarket = await registry.read.getMarket([secondMarketId]);
        const secondVault = await viem.getContractAt("BankVault4626", secondMarket.bank);
        await secondAsset.write.mint([admin.account.address, USDC("10000")]);
        await secondAsset.write.approve([secondVault.address, USDC("10000")], { account: admin.account });
        await secondVault.write.deposit([USDC("10000"), admin.account.address], { account: admin.account });
        await secondAsset.write.mint([alice.account.address, USDC("1000")]);
        await secondAsset.write.approve([secondVault.address, USDC("1000")], { account: alice.account });

        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }),
            admin.account,
        );
        await registerConfig(
            sideBet,
            config({ marketId: secondMarketId, betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 }),
            admin.account,
        );

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await sideBet.write.placeBet([1n, USDC("20")], { account: alice.account });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("100"));
        expect(await sideBet.read.reservedOf([secondMarketId])).to.equal(USDC("200"));

        await fulfillRounds(roundEngine, [2, 4, 6]);
        await settleViaScheduler(scheduler);

        expect(await sideBet.read.getBet([0n])).to.include({ status: Status.LOST });
        expect(await sideBet.read.getBet([1n])).to.include({ status: Status.LOST });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
        expect(await sideBet.read.reservedOf([secondMarketId])).to.equal(0n);
    });

    it("releases the reserve when an undecidable bet expires", async function () {
        const { sideBet, scheduler, admin, alice } = await deployFixture();
        await registerConfig(sideBet, config({ windowSpins: 5, multiplierBps: 100_000 }), admin.account);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(USDC("100"));

        // No round ever advances, so the bet never becomes decidable — expiry is its only exit.
        await time.increase(31 * 24 * 60 * 60);
        await settleViaScheduler(scheduler);

        expect(await sideBet.read.getBet([0n])).to.include({ status: Status.EXPIRED });
        expect(await sideBet.read.reservedOf([MARKET_ID])).to.equal(0n);
    });

    it("refuses the reserved-accounting migration on a proxy that already holds bets", async function () {
        const { sideBet, admin, alice } = await deployFixture();
        await registerConfig(sideBet, config(), admin.account);
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });

        await expect(
            sideBet.write.initializeReservedAccounting({ account: admin.account }),
        ).to.be.rejectedWith("ReservedAccountingMigrationUnsafe");
    });

    it("accepts the reserved-accounting migration once on an empty proxy", async function () {
        const { sideBet, admin } = await deployFixture();
        await sideBet.write.initializeReservedAccounting({ account: admin.account });
        await expect(
            sideBet.write.initializeReservedAccounting({ account: admin.account }),
        ).to.be.rejectedWith("InvalidInitialization");
    });
});

describe("SideBet fees", function () {
    async function deployFeeFixture(marketAsset: "usdc" | "brb") {
        const [admin, alice, infra] = await viem.getWalletClients();

        const usdc = await viem.deployContract("MockUSDC");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const asset = marketAsset === "brb" ? brb : usdc;

        const roundEngine = await viem.deployContract("MockRoundEngine");
        const mockRouter = await viem.deployContract("MockUniswapV2Router");
        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);

        const jackpotTreasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            roundEngine.address,
            admin.account.address,
        ]);

        const publicClient = await viem.getPublicClient();
        const nonceAfterTreasury = BigInt(
            await publicClient.getTransactionCount({ address: admin.account.address, blockTag: "latest" }),
        );
        // treasury, then funder + setFee, then registry + sideBet impl/proxy (no txs between registry and proxy).
        const predictedSideBet = predictSideBetProxyAddress(admin.account.address, nonceAfterTreasury + 3n);

        const funder = await viem.deployContract("BRBJackpotFunder", [
            roundEngine.address,
            brb.address,
            mockRouter.address,
            jackpotTreasury.address,
            predictedSideBet,
            admin.account.address,
        ]);
        await roundEngine.write.setFeeConfig([funder.address, infra.account.address]);

        const { registry } = await deploySideBetRegistryStack({
            admin: admin.account.address,
            roundEngine: roundEngine.address,
        });
        const { sideBet } = await deploySideBetProxy({
            admin: admin.account.address,
            roundEngine: roundEngine.address,
            registry: registry.address,
            minMultiplierBps: MIN_MULTIPLIER_BPS,
            maxMultiplierBps: MAX_MULTIPLIER_BPS,
        });
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

        const scheduler = await viem.deployContract("UpkeepScheduler", [
            roundEngine.address,
            sideBet.address,
            admin.account.address,
            32,
            32,
        ]);
        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, scheduler.address], { account: admin.account });
        await wireTestSchedulerForwarder(scheduler, admin.account);

        if (marketAsset === "usdc") {
            await brb.write.transfer([mockRouter.address, ROUTER_BRB_LIQUIDITY], { account: admin.account });
        }

        const minBet = marketAsset === "brb" ? parseUnits("1", 18) : USDC("1");
        await registry.write.createMarket(
            [{ asset: asset.address, bankAdmin: admin.account.address, minBet }],
            { account: admin.account },
        );
        const market = await registry.read.getMarket([MARKET_ID]);
        const vault = await viem.getContractAt("BankVault4626", market.bank);

        const lpAmount = marketAsset === "brb" ? parseUnits("10000", 18) : USDC("10000");
        if (marketAsset === "brb") {
            await brb.write.transfer([admin.account.address, lpAmount], { account: admin.account });
            await brb.write.approve([vault.address, lpAmount], { account: admin.account });
        } else {
            await usdc.write.mint([admin.account.address, lpAmount]);
            await usdc.write.approve([vault.address, lpAmount], { account: admin.account });
        }
        await vault.write.deposit([lpAmount, admin.account.address], { account: admin.account });

        const playerBudget = marketAsset === "brb" ? parseUnits("100", 18) : USDC("100");
        const stake = marketAsset === "brb" ? parseUnits("10", 18) : USDC("10");
        if (marketAsset === "brb") {
            await brb.write.transfer([alice.account.address, playerBudget], { account: admin.account });
            await brb.write.approve([vault.address, playerBudget], { account: alice.account });
        } else {
            await usdc.write.mint([alice.account.address, playerBudget]);
            await usdc.write.approve([vault.address, playerBudget], { account: alice.account });
        }

        return { sideBet, scheduler, vault, asset, brb, funder, jackpotTreasury, admin, alice, infra, stake, roundEngine };
    }

    it("collects infra and BRB jackpot funding on a losing USDC side bet", async function () {
        const { sideBet, scheduler, asset, brb, funder, jackpotTreasury, admin, alice, infra, stake, roundEngine } =
            await deployFeeFixture("usdc");

        await registerConfig(
            sideBet,
            config({ betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 1, multiplierBps: 100_000 }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, stake], { account: alice.account });

        const brbSupplyBefore = await brb.read.totalSupply();
        await fulfillRounds(roundEngine, [8]);
        await settleViaScheduler(scheduler);

        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.LOST);

        const marketWin = stake;
        const swapIn = (marketWin * (await funder.read.swapAssetTotalBps())) / SW_BPS_DENOM;
        const infraFee = (marketWin * INFRA_BPS) / SW_BPS_DENOM;

        expect(await asset.read.balanceOf([infra.account.address])).to.equal(infraFee);

        const brbOut = swapIn * 10n ** 12n;
        const treasuryNum = await funder.read.treasuryBrbNumerator();
        const treasuryDen = await funder.read.treasuryBrbDenominator();
        const toTreasury = (brbOut * treasuryNum) / treasuryDen;
        const toBurn = brbOut - toTreasury;

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(toTreasury);
        expect(await brb.read.totalSupply()).to.equal(brbSupplyBefore - toBurn);
    });

    it("splits BRB in-place on a losing BRB-market side bet (no Uniswap swap)", async function () {
        const { sideBet, scheduler, brb, funder, jackpotTreasury, admin, alice, infra, stake, roundEngine } =
            await deployFeeFixture("brb");

        await registerConfig(
            sideBet,
            config({
                betType: BetType.NUMBER_HIT,
                targetNumber: 7,
                targetCount: 1,
                windowSpins: 1,
                multiplierBps: 100_000,
                minStake: parseUnits("1", 18),
                maxStake: parseUnits("1000", 18),
            }),
            admin.account,
        );
        await sideBet.write.placeBet([0n, stake], { account: alice.account });

        const brbSupplyBefore = await brb.read.totalSupply();
        await fulfillRounds(roundEngine, [8]);
        await settleViaScheduler(scheduler);

        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.LOST);

        const marketWin = stake;
        const swapIn = (marketWin * (await funder.read.swapAssetTotalBps())) / SW_BPS_DENOM;
        const infraFee = (marketWin * INFRA_BPS) / SW_BPS_DENOM;

        expect(await brb.read.balanceOf([infra.account.address])).to.equal(infraFee);

        const treasuryNum = await funder.read.treasuryBrbNumerator();
        const treasuryDen = await funder.read.treasuryBrbDenominator();
        const toTreasury = (swapIn * treasuryNum) / treasuryDen;
        const toBurn = swapIn - toTreasury;

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(toTreasury);
        expect(await brb.read.totalSupply()).to.equal(brbSupplyBefore - toBurn);
    });
});
