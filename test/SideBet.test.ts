import { expect } from "chai";
import { encodeFunctionData, parseUnits, type Address } from "viem";
import { viem } from "hardhat";

const MIN_MULTIPLIER_BPS = 50_000; // 5x
const MAX_MULTIPLIER_BPS = 5_000_000; // 500x — headroom for >100x bet types
const RESOLVER_FEE_BPS = 10; // 0.1%

const USDC = (value: string): bigint => parseUnits(value, 6);

// ISideBet enum indices.
const BetType = {
    COLOR_COUNT: 0,
    NUMBER_HIT: 1,
    CONSECUTIVE_STREAK: 2,
    RED_RATIO: 3,
    LIGHTNING_DOUBLE: 4,
    PERFECT_ALTERNATION: 5,
    DOZEN_HIT: 6,
    COLUMN_HIT: 7,
} as const;
const ANY_NUMBER = 37;
const Color = { RED: 0, BLACK: 1 } as const;
const Status = { ACTIVE: 0, WON: 1, LOST: 2, EXPIRED: 3, CANCELLED: 4 } as const;

type ConfigInput = {
    token: Address;
    betType: number;
    color: number;
    targetNumber: number;
    targetCount: number;
    redRatioBps: number;
    windowSpins: number;
    multiplierBps: number;
    minStake: bigint;
    maxStake: bigint;
    enabled: boolean;
};

function config(overrides: Partial<ConfigInput> & { token: Address }): ConfigInput {
    return {
        betType: BetType.NUMBER_HIT,
        color: Color.RED,
        targetNumber: 0,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000, // 10x
        minStake: USDC("1"),
        maxStake: USDC("1000"),
        enabled: true,
        ...overrides,
    };
}

async function deployFixture() {
    const [admin, alice, bob, keeper, resolver] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
    const impl = await viem.deployContract("SideBet");
    const initData = encodeFunctionData({
        abi: impl.abi,
        functionName: "initialize",
        args: [admin.account.address, MIN_MULTIPLIER_BPS, MAX_MULTIPLIER_BPS, RESOLVER_FEE_BPS],
    });
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    const sideBet = await viem.getContractAt("SideBet", proxy.address);

    const feederRole = await sideBet.read.SPIN_FEEDER_ROLE();
    await sideBet.write.grantRole([feederRole, keeper.account.address], { account: admin.account });

    // Seed the house bankroll and the player's wallet.
    await usdc.write.mint([sideBet.address, USDC("10000")]);
    await usdc.write.mint([alice.account.address, USDC("1000")]);
    await usdc.write.approve([sideBet.address, USDC("1000")], { account: alice.account });

    return { sideBet, usdc, admin, alice, bob, keeper, resolver, publicClient };
}

async function feedSpins(sideBet: { write: { recordSpins: (a: [number[]], o: object) => Promise<unknown> } }, keeper: { account: { address: Address } }, numbers: number[]) {
    await sideBet.write.recordSpins([numbers], { account: keeper.account });
}

describe("SideBet", function () {
    it("initializes the multiplier band and resolver fee", async function () {
        const { sideBet } = await deployFixture();
        expect(await sideBet.read.minMultiplierBps()).to.equal(MIN_MULTIPLIER_BPS);
        expect(await sideBet.read.maxMultiplierBps()).to.equal(MAX_MULTIPLIER_BPS);
        expect(await sideBet.read.resolverFeeBps()).to.equal(RESOLVER_FEE_BPS);
    });

    it("resolves a NUMBER_HIT win and pays the player + reserves liability while active", async function () {
        const { sideBet, usdc, admin, alice, resolver, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 })],
            { account: admin.account },
        );

        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        // payout = 10 * 10x = 100; liability reserved against the bankroll.
        expect(await sideBet.read.reservedOf([usdc.address])).to.equal(USDC("100"));
        expect(await sideBet.read.idleBankrollOf([usdc.address])).to.equal(USDC("9910")); // 10000 + 10 stake - 100 reserved
        expect(await sideBet.read.isResolvable([0n])).to.equal(false);

        await feedSpins(sideBet, keeper, [2, 7, 4]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);

        await sideBet.write.resolve([0n], { account: resolver.account });

        const bet = await sideBet.read.getBet([0n]);
        expect(bet.status).to.equal(Status.WON);
        // alice: 1000 - 10 stake + 100 payout
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("1090"));
        // resolver fee = 10 stake * 0.1% = 0.01
        expect(await usdc.read.balanceOf([resolver.account.address])).to.equal(USDC("0.01"));
        expect(await sideBet.read.reservedOf([usdc.address])).to.equal(0n);
    });

    it("resolves a NUMBER_HIT loss, keeping the stake in the bankroll", async function () {
        const { sideBet, usdc, admin, alice, resolver, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 })],
            { account: admin.account },
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [2, 4, 6]);

        await sideBet.write.resolve([0n], { account: resolver.account });
        const bet = await sideBet.read.getBet([0n]);
        expect(bet.status).to.equal(Status.LOST);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(USDC("990")); // lost the stake
        // bankroll grew by the stake (10000 + 10), minus the tiny resolver fee paid to alice herself
        expect(await sideBet.read.bankrollOf([usdc.address])).to.equal(USDC("10010") - USDC("0.01"));
    });

    it("wins COLOR_COUNT early and loses on a fully-observed window", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.COLOR_COUNT, color: Color.RED, targetCount: 2, windowSpins: 4, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        // win: two reds (1, 3) within the window
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 3]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        // loss: four blacks/zero, no reds
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [2, 4, 6, 0]);
        await sideBet.write.resolve([1n], { account: alice.account });
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("wins CONSECUTIVE_STREAK early and loses when the streak breaks", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.CONSECUTIVE_STREAK, color: Color.RED, targetCount: 3, windowSpins: 5, multiplierBps: 60_000 })],
            { account: admin.account },
        );
        // win: three reds in a row (1,3,5)
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 3, 5]);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        // loss: reds never reach a run of 3 (alternating)
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 2, 1, 2, 1]);
        await sideBet.write.resolve([1n], { account: alice.account });
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("resolves RED_RATIO (early win, early loss)", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.RED_RATIO, redRatioBps: 6000, windowSpins: 5, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        // requiredReds = ceil(0.6 * 5) = 3. Early win once the 3rd red lands.
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 3, 5]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        // early loss: 3 blacks observed, only 2 spins remain -> can never reach 3 reds
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [2, 4, 6]);
        expect(await sideBet.read.isResolvable([1n])).to.equal(true);
        await sideBet.write.resolve([1n], { account: alice.account });
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("reverts placing a bet the bankroll cannot cover", async function () {
        const { sideBet, usdc, admin, alice } = await deployFixture();
        // Drain the bankroll to (almost) nothing: idle = 10000.
        await sideBet.write.withdrawBankroll([usdc.address, USDC("10000"), admin.account.address], { account: admin.account });
        await sideBet.write.addConfig([config({ token: usdc.address, multiplierBps: 100_000 })], { account: admin.account });
        // payout 100, stake 10 -> needs 90 of house liquidity, but idle is 0.
        await expect(sideBet.write.placeBet([0n, USDC("10")], { account: alice.account })).to.be.rejected;
    });

    it("reverts resolving before the outcome is decided, and is idempotent after", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.NUMBER_HIT, targetNumber: 7, targetCount: 1, windowSpins: 3 })],
            { account: admin.account },
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await expect(sideBet.write.resolve([0n], { account: alice.account })).to.be.rejected; // NotResolvableYet

        await feedSpins(sideBet, keeper, [7, 1, 2]);
        await sideBet.write.resolve([0n], { account: alice.account });
        await expect(sideBet.write.resolve([0n], { account: alice.account })).to.be.rejected; // AlreadyResolved
    });

    it("enforces access control on spins, configs and bankroll", async function () {
        const { sideBet, usdc, alice } = await deployFixture();
        await expect(sideBet.write.recordSpin([7], { account: alice.account })).to.be.rejected;
        await expect(sideBet.write.addConfig([config({ token: usdc.address })], { account: alice.account })).to.be.rejected;
        await expect(
            sideBet.write.withdrawBankroll([usdc.address, USDC("1"), alice.account.address], { account: alice.account }),
        ).to.be.rejected;
    });

    it("rejects a multiplier outside the configured band and invalid params", async function () {
        const { sideBet, usdc, admin } = await deployFixture();
        // 3x is below the 5x..20x band
        await expect(
            sideBet.write.addConfig([config({ token: usdc.address, multiplierBps: 30_000 })], { account: admin.account }),
        ).to.be.rejected;
        // windowSpins = 0
        await expect(
            sideBet.write.addConfig([config({ token: usdc.address, windowSpins: 0 })], { account: admin.account }),
        ).to.be.rejected;
    });

    it("records a spin sequence readable via getSpins", async function () {
        const { sideBet, keeper } = await deployFixture();
        await feedSpins(sideBet, keeper, [0, 7, 36, 12]);
        expect(await sideBet.read.spinCount()).to.equal(4n);
        const slice = await sideBet.read.getSpins([1n, 2n]);
        expect(slice).to.deep.equal([7, 36]);
    });

    it("resolves LIGHTNING_DOUBLE (any number twice in a row) at >100x odds", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [
                config({
                    token: usdc.address,
                    betType: BetType.LIGHTNING_DOUBLE,
                    targetNumber: ANY_NUMBER,
                    targetCount: 2,
                    windowSpins: 6,
                    multiplierBps: 1_500_000, // 150x
                }),
            ],
            { account: admin.account },
        );
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        // payout = 10 * 150 = 1500
        expect(await sideBet.read.reservedOf([usdc.address])).to.equal(USDC("1500"));

        await feedSpins(sideBet, keeper, [5, 5]);
        expect(await sideBet.read.isResolvable([0n])).to.equal(true);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });

    it("resolves PERFECT_ALTERNATION (win on full window, early loss on a same-colour pair)", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.PERFECT_ALTERNATION, windowSpins: 4, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        // win: red, black, red, black (1,2,1,2)
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        expect(await sideBet.read.isResolvable([0n])).to.equal(false);
        await feedSpins(sideBet, keeper, [1, 2, 1, 2]);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        // early loss: two reds in a row break the alternation immediately
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 3]);
        expect(await sideBet.read.isResolvable([1n])).to.equal(true);
        await sideBet.write.resolve([1n], { account: alice.account });
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("resolves DOZEN_HIT (early win, early loss on an impossible sweep)", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 3, windowSpins: 5, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        // win: three numbers in the first dozen (1-12)
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 2, 3]);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);

        // early loss: a sweep (5/5) is impossible after one miss
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.DOZEN_HIT, targetNumber: 1, targetCount: 5, windowSpins: 5, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        await sideBet.write.placeBet([1n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 13]); // 13 is in the 2nd dozen
        expect(await sideBet.read.isResolvable([1n])).to.equal(true);
        await sideBet.write.resolve([1n], { account: alice.account });
        expect((await sideBet.read.getBet([1n])).status).to.equal(Status.LOST);
    });

    it("resolves COLUMN_HIT", async function () {
        const { sideBet, usdc, admin, alice, keeper } = await deployFixture();
        await sideBet.write.addConfig(
            [config({ token: usdc.address, betType: BetType.COLUMN_HIT, targetNumber: 1, targetCount: 2, windowSpins: 4, multiplierBps: 50_000 })],
            { account: admin.account },
        );
        // column 1 = {1,4,7,...}; 1 and 4 both qualify
        await sideBet.write.placeBet([0n, USDC("10")], { account: alice.account });
        await feedSpins(sideBet, keeper, [1, 4]);
        await sideBet.write.resolve([0n], { account: alice.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(Status.WON);
    });
});
