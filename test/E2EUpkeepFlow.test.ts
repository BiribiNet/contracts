import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deployE2EStack(params?: { marketCount?: number; maxPayoutsPerCall?: number }) {
    const marketCount = params?.marketCount ?? 3;
    const maxPayoutsPerCall = params?.maxPayoutsPerCall ?? 3;

    const [admin, alice, bob, carol, dave] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const assets = [];
    for (let i = 0; i < marketCount; i++) {
        assets.push(await viem.deployContract("MockUSDC"));
    }
    const vrf = await viem.deployContract("MockVrfCoordinator");

    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const mockRouter = await viem.deployContract("MockUniswapV2Router");
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler, registry, jackpotTreasury, funder } = await deployRouletteEngine(
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
        { admin: admin.account.address, scanLimit: 10, maxPayoutsPerCall },
        {
            protocolPrefix: {
                brb: brb.address,
                mockRouter: mockRouter.address,
                admin: admin.account.address,
            },
        },
    );

    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    await scheduler.write.setScanLimit([12], { account: admin.account });
    await scheduler.write.setMaxPayoutsPerCall([maxPayoutsPerCall], { account: admin.account });

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    for (let i = 0; i < marketCount; i++) {
        await registry.write.createMarket(
            [
                {
                    asset: assets[i].address,
                    bankAdmin: admin.account.address,
                    minBet: 1_000_000n,
                },
            ],
            { account: admin.account },
        );
    }

    const banks = [];
    for (let i = 0; i < marketCount; i++) {
        const cfg = await registry.read.getMarket([i + 1]);
        banks.push(await viem.getContractAt("BankVault4626", cfg.bank));
    }

    return {
        publicClient,
        admin,
        alice,
        bob,
        carol,
        dave,
        assets,
        brb,
        vrf,
        registry,
        engine,
        scheduler,
        banks,
        jackpotTreasury,
        funder,
    };
}

async function runUpkeepUntilIdle(scheduler: Parameters<typeof runParallelLanesUntilIdle>[0], maxIters = 400) {
    await runParallelLanesUntilIdle(scheduler, { maxIters });
}

describe("E2E upkeep flow", function () {
    it("runs full rounds end-to-end and keeps upkeep surface consistent", async function () {
        const { scheduler, engine, banks, alice, bob, carol, dave, assets, vrf, publicClient, admin, brb } =
            await deployE2EStack({ marketCount: 4, maxPayoutsPerCall: 2 });

        expect(await engine.read.currentGlobalRound()).to.equal(1n);

        // Fund players and approve per market.
        const players = [alice, bob, carol, dave];
        for (let m = 0; m < banks.length; m++) {
            const token = assets[m];
            for (const p of players) {
                await token.write.mint([p.account.address, parseUnits("1000", 6)]);
                await token.write.approve([banks[m].address, parseUnits("1000", 6)], { account: p.account });
            }

            // Seed vault liquidity so winners can be paid (E2E realism).
            const lpAmount = parseUnits("5000", 6);
            await token.write.mint([admin.account.address, lpAmount]);
            await token.write.approve([banks[m].address, lpAmount], { account: admin.account });
            await banks[m].write.deposit([lpAmount, admin.account.address], { account: admin.account });
        }

        // Round 1 bets across all markets. Winning number will be 7.
        const betAmount = parseUnits("10", 6);
        const betData7 = encodeSingleBet(1n, 7n, betAmount);
        for (let m = 0; m < banks.length; m++) {
            await banks[m].write.placeBet([betAmount, betData7, zeroAddress], { account: players[m % players.length].account });
        }

        // Lock + request VRF + fulfill + pay out.
        await time.increase(550);
        await runUpkeepUntilIdle(scheduler);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);
        await runUpkeepUntilIdle(scheduler);

        // Round 2: same mod-37 pair (7,7) so jackpot triggers.
        await runUpkeepUntilIdle(scheduler);
        for (let m = 0; m < banks.length; m++) {
            // Two jackpot-eligible straight bets on each market to force batching.
            await banks[m].write.placeBet([betAmount, betData7, zeroAddress], { account: players[(m + 1) % players.length].account });
            await banks[m].write.placeBet([betAmount, betData7, zeroAddress], { account: players[(m + 2) % players.length].account });
        }
        await time.increase(550);
        await runUpkeepUntilIdle(scheduler);
        await vrf.write.fulfillWithJackpot([engine.address, 2n, 7n, 7n]);

        // Ensure scheduler calls stay within a conservative bound in this E2E run.
        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        if (needed) {
            const gas = await publicClient.estimateContractGas({
                address: scheduler.address,
                abi: scheduler.abi,
                functionName: "performUpkeep",
                args: [performData],
                account: admin.account,
            });
            expect(gas).to.be.lt(2_500_000n);
        }

        await runUpkeepUntilIdle(scheduler);

        // Jackpot should have been distributed (pool drained) or at least decreased.
        expect(await brb.read.balanceOf([scheduler.address])).to.equal(0n);
    });
});

