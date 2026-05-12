import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { encodeAbiParameters, parseUnits } from "viem";

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

    const assets = await Promise.all(Array.from({ length: marketCount }, async () => viem.deployContract("MockUSDC")));
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

    const engine = await viem.deployContract("RouletteEngine", [
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
    ]);

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });

    const ratio = 10n ** 30n;
    for (let i = 0; i < marketCount; i++) {
        await funder.write.setBrbPerAssetUnitRatio([BigInt(i + 1), ratio], { account: admin.account });
    }

    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    const scheduler = await viem.deployContract("UpkeepScheduler", [
        engine.address,
        admin.account.address,
        10,
        maxPayoutsPerCall,
    ]);
    await engine.write.registerScheduler([scheduler.address, true]);

    // Touch admin setters for coverage (and to validate they work).
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
                    bankName: `Bank ${i}`,
                    bankSymbol: `b${i}`,
                    bankAdmin: admin.account.address,
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

async function runUpkeepUntilIdle(opts: {
    scheduler: any;
    lanes: bigint[];
    maxIters?: number;
}) {
    const maxIters = opts.maxIters ?? 200;
    for (let i = 0; i < maxIters; i++) {
        let progressed = false;
        for (const lane of opts.lanes) {
            const checkData =
                lane === 0n ? ("0x" as const) : encodeAbiParameters([{ type: "uint256" }], [lane]);
            const [needed, performData] = await opts.scheduler.read.checkUpkeep([checkData]);
            if (needed) {
                progressed = true;
                await opts.scheduler.write.performUpkeep([performData]);
            }
        }
        if (!progressed) return;
    }
    throw new Error("upkeep loop did not converge");
}

describe("E2E upkeep flow", function () {
    it("runs full rounds end-to-end and keeps upkeep surface consistent", async function () {
        const { scheduler, engine, banks, alice, bob, carol, dave, assets, vrf, publicClient, admin, brb } =
            await deployE2EStack({ marketCount: 4, maxPayoutsPerCall: 2 });

        // Open the first round.
        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });

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
            await banks[m].write.placeBet([betAmount, betData7], { account: players[m % players.length].account });
        }

        // Seal + request VRF + fulfill + pay out.
        await time.increase(550);
        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);
        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });

        // Round 2: same mod-37 pair (7,7) so jackpot triggers.
        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });
        for (let m = 0; m < banks.length; m++) {
            // Two jackpot-eligible straight bets on each market to force batching.
            await banks[m].write.placeBet([betAmount, betData7], { account: players[(m + 1) % players.length].account });
            await banks[m].write.placeBet([betAmount, betData7], { account: players[(m + 2) % players.length].account });
        }
        await time.increase(550);
        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });
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

        await runUpkeepUntilIdle({ scheduler, lanes: [0n, 1n] });

        // Jackpot should have been distributed (pool drained) or at least decreased.
        expect(await brb.read.balanceOf([scheduler.address])).to.equal(0n);
    });
});

