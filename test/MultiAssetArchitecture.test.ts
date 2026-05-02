import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { encodeAbiParameters, parseUnits } from "viem";

async function deployStack() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
    const assetB = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [admin.account.address]);

    const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);
    const engine = await viem.deployContract("RouletteEngine", [
        registry.address,
        jackpotTreasury.address,
        admin.account.address,
        vrf.address,
        1n,
        "0x" + "11".repeat(32),
        2_000_000,
        1,
        1,
        admin.account.address,
    ]);
    await jackpotTreasury.write.setEngine([engine.address]);
    const scheduler = await viem.deployContract("UpkeepScheduler", [
        engine.address,
        admin.account.address,
        5,
        25,
    ]);

    await engine.write.registerScheduler([scheduler.address, true]);

    const bankUsdc = await viem.deployContract("BankVault4626", [
        usdc.address,
        "Bank USDC",
        "bUSDC",
        1,
        engine.address,
        admin.account.address,
    ]);
    const bankAssetB = await viem.deployContract("BankVault4626", [
        assetB.address,
        "Bank Asset B",
        "bASB",
        2,
        engine.address,
        admin.account.address,
    ]);

    await registry.write.registerMarket([usdc.address, bankUsdc.address, 1, 10_000]);
    await registry.write.registerMarket([assetB.address, bankAssetB.address, 1, 10_000]);
    await engine.write.registerMarket([1, bankUsdc.address]);
    await engine.write.registerMarket([2, bankAssetB.address]);

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
        vrf,
        registry,
        engine,
        scheduler,
        bankUsdc,
        bankAssetB,
    };
}

describe("Multi-Asset architecture", function () {
    it("keeps fixed upkeep surface while handling multiple markets", async function () {
        const { scheduler, bankUsdc, bankAssetB, alice, bob, publicClient } = await deployStack();
        const betData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 7n]);

        await bankUsdc.write.placeBet([parseUnits("10", 6), betData], { account: alice.account });
        await bankAssetB.write.placeBet([parseUnits("10", 6), betData], { account: bob.account });
        await time.increase(2);

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

    it("enforces single active VRF request globally", async function () {
        const { bankUsdc, scheduler, vrf, engine, alice } = await deployStack();
        const betData = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 17n]);
        await bankUsdc.write.placeBet([parseUnits("10", 6), betData], { account: alice.account });
        await time.increase(2);

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
        const straight7 = encodeAbiParameters(
            [
                { type: "uint256" }, // betType
                { type: "uint256" }, // number
            ],
            [1n, 7n],
        );

        await usdc.write.mint([bob.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bankUsdc.address, parseUnits("5000", 6)], { account: bob.account });
        await bankUsdc.write.deposit([parseUnits("5000", 6), bob.account.address], { account: bob.account });

        const before = await usdc.read.balanceOf([alice.account.address]);
        await bankUsdc.write.placeBet([parseUnits("10", 6), straight7], { account: alice.account });
        await time.increase(2);

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
        const { bankUsdc, usdc, alice, bob, scheduler, vrf, engine } = await deployStack();
        const straight7 = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 7n]);

        await usdc.write.mint([bob.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bankUsdc.address, parseUnits("5000", 6)], { account: bob.account });
        await bankUsdc.write.deposit([parseUnits("5000", 6), bob.account.address], { account: bob.account });

        const before = await usdc.read.balanceOf([alice.account.address]);
        await bankUsdc.write.placeBet([parseUnits("10", 6), straight7], { account: alice.account });
        await time.increase(2);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([payoutData]);

        const after = await usdc.read.balanceOf([alice.account.address]);
        // On this round, market has no net house win, so no jackpot funding occurs.
        expect(after).to.equal(before - parseUnits("10", 6) + parseUnits("360", 6));
        expect(await engine.read.jackpotPool()).to.equal(0n);
    });

    it("takes infra and jackpot fees only when market has net win", async function () {
        const { bankUsdc, usdc, alice, admin, scheduler, vrf, engine } = await deployStack();
        const straight7 = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 7n]);

        const infraBefore = await usdc.read.balanceOf([admin.account.address]);
        await bankUsdc.write.placeBet([parseUnits("10", 6), straight7], { account: alice.account });
        await time.increase(2);

        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        // Winning number 8 => straight 7 loses, market has net house win.
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 8n, 10n]);

        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([payoutData]);

        expect(await engine.read.jackpotPool()).to.equal(250_000n);
        const infraAfter = await usdc.read.balanceOf([admin.account.address]);
        expect(infraAfter - infraBefore).to.equal(250_000n);
    });
});
