import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { decodeRoulettePerformData } from "./helpers/decodeUpkeepPerformData";
import { laneCheckData, runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

const LANE_COUNT = 10n;

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deployThreeMarketStack(maxPayoutsPerCall: number) {
    const [admin, alice, bob, carol] = await viem.getWalletClients();

    const usdc = await viem.deployContract("MockUSDC");
    const mockDai = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);

    const mockRouter = await viem.deployContract("MockUniswapV2Router");
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler, registry } = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            zeroAddress,
            zeroAddress,
            zeroAddress,
            admin.account.address,
            vrf.address,
            1n,
            2_000_000,
            1,
            500,
            admin.account.address,
        ],
        { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall },
        {
            protocolPrefix: {
                brb: brb.address,
                mockRouter: mockRouter.address,
                admin: admin.account.address,
            },
        },
    );

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    for (const asset of [usdc, mockDai, brb]) {
        await registry.write.createMarket([{ asset: asset.address, bankAdmin: admin.account.address,

 minBet: 1_000_000n }], {
            account: admin.account,
        });
    }

    const bankUsdc = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    const bankDai = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([2])).bank);
    const bankBrb = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([3])).bank);

    const lpUsdc = parseUnits("50000", 6);
    const lpBrb = parseUnits("50000", 18);
    await usdc.write.mint([admin.account.address, lpUsdc]);
    await usdc.write.approve([bankUsdc.address, lpUsdc], { account: admin.account });
    await bankUsdc.write.deposit([lpUsdc, admin.account.address], { account: admin.account });
    await mockDai.write.mint([admin.account.address, lpUsdc]);
    await mockDai.write.approve([bankDai.address, lpUsdc], { account: admin.account });
    await bankDai.write.deposit([lpUsdc, admin.account.address], { account: admin.account });
    await brb.write.approve([bankBrb.address, lpBrb], { account: admin.account });
    await bankBrb.write.deposit([lpBrb, admin.account.address], { account: admin.account });

    return { admin, alice, bob, carol, usdc, mockDai, brb, vrf, engine, scheduler, bankUsdc, bankDai, bankBrb };
}

describe("Ten-lane parallel payout upkeeps", function () {
    it("exposes 10 lanes and settles three markets without duplicate payouts", async function () {
        const { admin, alice, bob, carol, usdc, mockDai, brb, vrf, engine, scheduler, bankUsdc, bankDai, bankBrb } =
            await deployThreeMarketStack(15);

        expect(await engine.read.payoutParallelLaneCount()).to.equal(LANE_COUNT);

        const betUsdc = parseUnits("10", 6);
        const betDai = parseUnits("10", 6);
        const betBrb = parseUnits("10", 18);
        const straight7 = encodeSingleBet(1n, 7n, betUsdc);

        await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await mockDai.write.mint([bob.account.address, parseUnits("1000", 6)]);
        await brb.write.transfer([carol.account.address, parseUnits("1000", 18)], { account: admin.account });
        await usdc.write.approve([bankUsdc.address, parseUnits("1000", 6)], { account: alice.account });
        await mockDai.write.approve([bankDai.address, parseUnits("1000", 6)], { account: bob.account });
        await brb.write.approve([bankBrb.address, parseUnits("1000", 18)], { account: carol.account });

        const usdcBefore = await usdc.read.balanceOf([alice.account.address]);
        const daiBefore = await mockDai.read.balanceOf([bob.account.address]);
        const brbBefore = await brb.read.balanceOf([carol.account.address]);

        await bankUsdc.write.placeBet([betUsdc, straight7, zeroAddress], { account: alice.account });
        await bankDai.write.placeBet([betDai, encodeSingleBet(1n, 7n, betDai), zeroAddress], { account: bob.account });
        await bankBrb.write.placeBet([betBrb, encodeSingleBet(1n, 7n, betBrb), zeroAddress], { account: carol.account });

        await time.increase(550);
        await runParallelLanesUntilIdle(scheduler);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);
        await runParallelLanesUntilIdle(scheduler, { maxIters: 800 });

        for (const marketId of [1, 2, 3]) {
            const st = await engine.read.marketRoundStateByRound([1n, marketId]);
            const settled = Array.isArray(st) ? Boolean(st[3]) : Boolean((st as { settled: boolean }).settled);
            expect(settled).to.equal(true);
        }

        const usdcGain = (await usdc.read.balanceOf([alice.account.address])) - usdcBefore;
        const daiGain = (await mockDai.read.balanceOf([bob.account.address])) - daiBefore;
        const brbGain = (await brb.read.balanceOf([carol.account.address])) - brbBefore;

        expect(usdcGain).to.equal(parseUnits("360", 6) - betUsdc);
        expect(daiGain).to.equal(parseUnits("360", 6) - betDai);
        expect(brbGain).to.equal(parseUnits("360", 18) - betBrb);
    });

    it("shards vault payouts for the same market across all lanes", async function () {
        const { alice, bob, carol, usdc, vrf, engine, scheduler, bankUsdc } = await deployThreeMarketStack(5);

        const bet = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, bet);
        for (const p of [alice, bob, carol]) {
            await usdc.write.mint([p.account.address, parseUnits("500", 6)]);
            await usdc.write.approve([bankUsdc.address, parseUnits("500", 6)], { account: p.account });
            await bankUsdc.write.placeBet([bet, straight7, zeroAddress], { account: p.account });
        }

        await time.increase(550);
        await runParallelLanesUntilIdle(scheduler, { maxIters: 50 });
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);

        let lanesWithWork = 0;
        for (let lane = 0; lane < Number(LANE_COUNT); lane++) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(BigInt(lane))]);
            if (!needed) continue;
            lanesWithWork++;
            const decoded = decodeRoulettePerformData(performData);
            expect(decoded.workKind).to.equal(0);
            expect(decoded.lane).to.equal(lane);
            expect(decoded.jobKind).to.equal(3);
            expect(decoded.marketId).to.equal(1);
            expect(decoded.shardIndex).to.equal(lane);
            expect(decoded.shardWidth).to.equal(Number(LANE_COUNT));
        }
        expect(lanesWithWork).to.be.greaterThan(0);

        await runParallelLanesUntilIdle(scheduler, { maxIters: 200 });
        const st = await engine.read.marketRoundStateByRound([1n, 1n]);
        const settled = Array.isArray(st) ? Boolean(st[3]) : Boolean((st as { settled: boolean }).settled);
        expect(settled).to.equal(true);
    });
});
