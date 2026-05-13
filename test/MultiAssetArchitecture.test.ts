import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { viem } from "hardhat";
import { encodeAbiParameters, parseUnits } from "viem";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deployStack() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
    const assetB = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");

    const brb = await viem.deployContract("BRBToken", [admin.account.address]);

    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
    const mockRouter = await viem.deployContract("MockUniswapV2Router");

    const funder = await viem.deployContract("BRBJackpotFunder", [
        "0x0000000000000000000000000000000000000000",
        brb.address,
        mockRouter.address,
        jackpotTreasury.address,
        admin.account.address,
    ]);

    const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);

    const { engine, scheduler } = await deployRouletteEngine(
        [
            registry.address,
            jackpotTreasury.address,
            funder.address,
            admin.account.address,
            vrf.address,
            1n,
            "0x" + "11".repeat(32),
            2_000_000,
            1,
            500,
            admin.account.address,
        ],
        { admin: admin.account.address, scanLimit: 5, maxPayoutsPerCall: 25 },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });

    const ratio = 10n ** 30n;
    await funder.write.setBrbPerAssetUnitRatio([1n, ratio], { account: admin.account });
    await funder.write.setBrbPerAssetUnitRatio([2n, ratio], { account: admin.account });

    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
        [
            {
                asset: usdc.address,
                bankName: "Bank USDC",
                bankSymbol: "bUSDC",
                bankAdmin: admin.account.address,
            },
        ],
        { account: admin.account },
    );
    await registry.write.createMarket(
        [
            {
                asset: assetB.address,
                bankName: "Bank Asset B",
                bankSymbol: "bASB",
                bankAdmin: admin.account.address,
            },
        ],
        { account: admin.account },
    );

    const cfg1 = await registry.read.getMarket([1]);
    const cfg2 = await registry.read.getMarket([2]);
    const bankUsdc = await viem.getContractAt("BankVault4626", cfg1.bank);
    const bankAssetB = await viem.getContractAt("BankVault4626", cfg2.bank);

    const [openNeeded, openData] = await scheduler.read.checkUpkeep(["0x"]);
    expect(openNeeded).to.equal(true);
    await scheduler.write.performUpkeep([openData], { account: admin.account });

    await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
    await assetB.write.mint([bob.account.address, parseUnits("1000", 6)]);
    await usdc.write.approve([bankUsdc.address, parseUnits("500", 6)], { account: alice.account });
    await assetB.write.approve([bankAssetB.address, parseUnits("500", 6)], { account: bob.account });

    return {
        publicClient,
        admin,
        alice,
        bob,
        usdc,
        assetB,
        brb,
        vrf,
        registry,
        engine,
        scheduler,
        bankUsdc,
        bankAssetB,
        jackpotTreasury,
        funder,
        factory: registry,
    };
}

/** Buffered straight max payout needs LP depth in the ERC-4626 pool (excluding pending bets). */
async function depositLpForStraightCover(
    admin: { account: import("viem").Account },
    bankUsdc: { address: `0x${string}`; write: { deposit(args: unknown[], opts?: unknown): Promise<unknown> } },
    bankAssetB: { address: `0x${string}`; write: { deposit(args: unknown[], opts?: unknown): Promise<unknown> } },
    usdc: { write: { mint(args: unknown[]): Promise<unknown>; approve(args: unknown[], opts?: unknown): Promise<unknown> } },
    assetB: { write: { mint(args: unknown[]): Promise<unknown>; approve(args: unknown[], opts?: unknown): Promise<unknown> } },
    lpPerBank = parseUnits("5000", 6),
) {
    await usdc.write.mint([admin.account.address, lpPerBank * 4n]);
    await assetB.write.mint([admin.account.address, lpPerBank * 4n]);
    await usdc.write.approve([bankUsdc.address, lpPerBank], { account: admin.account });
    await assetB.write.approve([bankAssetB.address, lpPerBank], { account: admin.account });
    await bankUsdc.write.deposit([lpPerBank, admin.account.address], { account: admin.account });
    await bankAssetB.write.deposit([lpPerBank, admin.account.address], { account: admin.account });
}

describe("Multi-Asset architecture", function () {
    it("keeps fixed upkeep surface while handling multiple markets", async function () {
        const { scheduler, bankUsdc, bankAssetB, alice, bob, admin, publicClient, usdc, assetB } = await deployStack();
        await depositLpForStraightCover(admin, bankUsdc, bankAssetB, usdc, assetB);
        const amount = parseUnits("10", 6);
        const betData = encodeSingleBet(1n, 7n, amount);

        await bankUsdc.write.placeBet([amount, betData], { account: alice.account });
        await bankAssetB.write.placeBet([amount, betData], { account: bob.account });
        await time.increase(550);

        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);

        const gas = await publicClient.estimateContractGas({
            address: scheduler.address,
            abi: scheduler.abi,
            functionName: "performUpkeep",
            args: [performData],
            account: alice.account,
        });
        expect(gas).to.be.lt(2_000_000n);

        await scheduler.write.performUpkeep([performData]);
    });

    it("rejects bets after lock when PreLock is eligible (aligns with checkUpkeep)", async function () {
        const { scheduler, bankUsdc, bankAssetB, alice, bob, usdc, assetB, admin } = await deployStack();
        await depositLpForStraightCover(admin, bankUsdc, bankAssetB, usdc, assetB);
        const amount = parseUnits("10", 6);
        const betData = encodeSingleBet(1n, 7n, amount);

        await bankUsdc.write.placeBet([amount, betData], { account: alice.account });
        await time.increase(550);

        const [preLockNeeded] = await scheduler.read.checkUpkeep(["0x"]);
        expect(preLockNeeded).to.equal(true);

        await expect(bankAssetB.write.placeBet([amount, betData], { account: bob.account })).to.be.rejected;

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
    });

    it("enforces single active VRF request globally", async function () {
        const { bankUsdc, bankAssetB, scheduler, vrf, engine, alice, admin, usdc, assetB } = await deployStack();
        await depositLpForStraightCover(admin, bankUsdc, bankAssetB, usdc, assetB);
        const amount = parseUnits("10", 6);
        const betData = encodeSingleBet(1n, 17n, amount);
        await bankUsdc.write.placeBet([amount, betData], { account: alice.account });
        await time.increase(550);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);

        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);

        expect(await engine.read.hasPendingVrf()).to.equal(true);
        const [neededAfterPending] = await scheduler.read.checkUpkeep(["0x"]);
        expect(neededAfterPending).to.equal(false);

        await vrf.write.fulfill([engine.address, 1n, 777n]);
        expect(await engine.read.hasPendingVrf()).to.equal(false);
    });

    it("keeps liquidity and APY base independent per bank asset", async function () {
        const { bankUsdc, bankAssetB, usdc, assetB, alice, bob } = await deployStack();

        await usdc.write.approve([bankUsdc.address, parseUnits("100", 6)], { account: alice.account });
        await bankUsdc.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        await assetB.write.approve([bankAssetB.address, parseUnits("100", 6)], { account: bob.account });
        await bankAssetB.write.deposit([parseUnits("100", 6), bob.account.address], { account: bob.account });

        const usdcAssets = await bankUsdc.read.totalAssets();
        const assetBAssets = await bankAssetB.read.totalAssets();

        expect(usdcAssets).to.equal(parseUnits("100", 6));
        expect(assetBAssets).to.equal(parseUnits("100", 6));
    });

    it("supports typed roulette bets with legacy payout multipliers", async function () {
        const { bankUsdc, usdc, alice, bob, scheduler, vrf, engine } = await deployStack();
        const betAmount = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, betAmount);

        await usdc.write.mint([bob.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bankUsdc.address, parseUnits("5000", 6)], { account: bob.account });
        await bankUsdc.write.deposit([parseUnits("5000", 6), bob.account.address], { account: bob.account });

        const before = await usdc.read.balanceOf([alice.account.address]);
        await bankUsdc.write.placeBet([betAmount, straight7], { account: alice.account });
        await time.increase(550);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 13n]);

        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([payoutData]);

        const after = await usdc.read.balanceOf([alice.account.address]);
        expect(after).to.equal(before - parseUnits("10", 6) + parseUnits("360", 6));
    });

    it("funds and pays jackpot when winning and jackpot numbers match", async function () {
        const { bankUsdc, usdc, alice, bob, scheduler, vrf, engine, jackpotTreasury } = await deployStack();
        const betAmount = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, betAmount);

        await usdc.write.mint([bob.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bankUsdc.address, parseUnits("5000", 6)], { account: bob.account });
        await bankUsdc.write.deposit([parseUnits("5000", 6), bob.account.address], { account: bob.account });

        const before = await usdc.read.balanceOf([alice.account.address]);
        await bankUsdc.write.placeBet([betAmount, straight7], { account: alice.account });
        await time.increase(550);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([payoutData]);

        const after = await usdc.read.balanceOf([alice.account.address]);
        expect(after).to.equal(before - parseUnits("10", 6) + parseUnits("360", 6));
        expect(await jackpotTreasury.read.jackpotPool()).to.equal(0n);
    });

    it("takes infra fee and swaps market win slice to BRB for jackpot", async function () {
        const { bankUsdc, bankAssetB, usdc, assetB, alice, admin, scheduler, vrf, engine, brb, jackpotTreasury } =
            await deployStack();
        await depositLpForStraightCover(admin, bankUsdc, bankAssetB, usdc, assetB);
        const betAmount = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, betAmount);

        const infraBefore = await usdc.read.balanceOf([admin.account.address]);
        await bankUsdc.write.placeBet([betAmount, straight7], { account: alice.account });
        await time.increase(550);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        const brbSupplyBeforeFulfill = await brb.read.totalSupply();
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 8n, 10n]);

        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([payoutData]);

        const marketWin = parseUnits("10", 6);
        const swapIn = (marketWin * 300n) / 10_000n;
        const brbOut = swapIn * 10n ** 12n;
        const toTreasury = (brbOut * 250n) / 300n;
        const toBurn = brbOut - toTreasury;

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(toTreasury);
        const infraAfter = await usdc.read.balanceOf([admin.account.address]);
        expect(infraAfter - infraBefore).to.equal(250_000n);

        expect(await brb.read.totalSupply()).to.equal(brbSupplyBeforeFulfill - toBurn);
    });
});
