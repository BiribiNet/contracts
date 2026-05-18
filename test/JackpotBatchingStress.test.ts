import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeAbiParameters, parseUnits } from "viem";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deploySingleMarket(maxPayoutsPerCall: number) {
    const [admin, alice] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
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
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler } = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            registry.address,
            jackpotTreasury.address,
            funder.address,
            admin.account.address,
            vrf.address,
            1n,
            2_000_000,
            1,
            500,
            admin.account.address,
        ],
        { admin: admin.account.address, scanLimit: 15, maxPayoutsPerCall: maxPayoutsPerCall },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });


    // Ensure treasury has BRB before jackpot triggers (so batch payout is meaningful).
    await brb.write.transfer([jackpotTreasury.address, parseUnits("1000", 18)], { account: admin.account });

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
                [
                    {
                        asset: usdc.address,
                        bankAdmin: admin.account.address,
                    },
                ],
        { account: admin.account },
    );
    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    // Seed liquidity to cover 36x payouts.
    const lpAmount = parseUnits("20000", 6);
    await usdc.write.mint([admin.account.address, lpAmount]);
    await usdc.write.approve([bank.address, lpAmount], { account: admin.account });
    await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });

    // Fund bettor.
    await usdc.write.mint([alice.account.address, parseUnits("50000", 6)]);
    await usdc.write.approve([bank.address, parseUnits("50000", 6)], { account: alice.account });

    return { publicClient, admin, alice, usdc, brb, vrf, engine, scheduler, bank, jackpotTreasury };
}

async function performOneUpkeep(scheduler: any, lane: bigint) {
    const checkData =
        lane === 0n ? ("0x" as const) : encodeAbiParameters([{ type: "uint256" }], [lane]);
    const [needed, performData] = await scheduler.read.checkUpkeep([checkData]);
    if (!needed) return false;
    await scheduler.write.performUpkeep([performData]);
    return true;
}

describe("Jackpot batching stress", function () {
    it("pays jackpot across multiple upkeep calls (respects maxPayoutsPerCall)", async function () {
        const { engine, scheduler, bank, alice, vrf, jackpotTreasury } = await deploySingleMarket(5);

        expect(await engine.read.currentGlobalRound()).to.equal(1n);

        const betAmount = parseUnits("10", 6);
        const betData7 = encodeSingleBet(1n, 7n, betAmount);

        // Round 1: winning 7 vs second word yielding a different mod 37 (no jackpot this round).
        await bank.write.placeBet([betAmount, betData7], { account: alice.account });
        await time.increase(550);
        while (await performOneUpkeep(scheduler, 0n)) {}
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);
        while (await performOneUpkeep(scheduler, 0n)) {}

        expect(await engine.read.currentGlobalRound()).to.equal(2n);

        // Round 2: many jackpot-eligible bets on winning/jackpot number 7.
        // Using same player repeatedly still creates many winner entries.
        const winnerCount = 40;
        for (let i = 0; i < winnerCount; i++) {
            await bank.write.placeBet([betAmount, betData7], { account: alice.account });
        }
        await time.increase(550);
        while (await performOneUpkeep(scheduler, 0n)) {}
        await vrf.write.fulfillWithJackpot([engine.address, 2n, 7n, 7n]);

        // First payout call should decrease pool but not drain it (batching).
        const poolBefore = await jackpotTreasury.read.jackpotPool();
        expect(poolBefore).to.be.gt(0n);

        // Drive upkeep until idle; count payout calls.
        let payoutCalls = 0;
        for (let i = 0; i < 200; i++) {
            const progressed = await performOneUpkeep(scheduler, 0n);
            if (!progressed) break;
            payoutCalls++;
        }
        const poolAfter = await jackpotTreasury.read.jackpotPool();
        expect(poolAfter).to.equal(0n);

        // With 40 winners and maxPayoutsPerCall=5, jackpot alone needs >1 batch.
        expect(payoutCalls).to.be.gt(1);
    });
});

