import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeAbiParameters, parseUnits } from "viem";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deploySingleMarket(opts: { maxPayoutsPerCall: number }) {
    const [admin] = await viem.getWalletClients();

    const asset = await viem.deployContract("MockUSDC");
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
        { admin: admin.account.address, scanLimit: 250, maxPayoutsPerCall: opts.maxPayoutsPerCall },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });
    expect(await engine.read.payoutParallelLaneCount()).to.equal(10n);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: asset.address, bankAdmin: admin.account.address,

 minBet: 1_000_000n }],
        { account: admin.account },
    );

    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    return {
        admin,
        asset,
        vrf,
        engine,
        scheduler,
        bank,
    };
}

async function runLaneUntilStable(opts: {
    scheduler: { read: any; write: any };
    lanes: bigint[];
    rounds: number;
}) {
    for (let r = 0; r < opts.rounds; r++) {
        let progressed = false;
        for (const lane of opts.lanes) {
            const checkData = lane === 0n ? "0x" : encodeAbiParameters([{ type: "uint256" }], [lane]);
            const [needed, pd] = await opts.scheduler.read.checkUpkeep([checkData]);
            if (needed) {
                progressed = true;
                await opts.scheduler.write.performUpkeep([pd]);
            }
        }
        if (!progressed) return;
    }
    throw new Error("expected convergence");
}

describe("Payout upkeep (sequential winner chunks)", function () {
    it("settles a crowded round using chunked maxPayoutsPerCall on a single automation lane", async function () {
        const { admin, engine, scheduler, vrf, bank, asset } = await deploySingleMarket({
            maxPayoutsPerCall: 2,
        });

        const lpAmount = parseUnits("5000", 6);
        await asset.write.mint([admin.account.address, lpAmount], { account: admin.account });
        await asset.write.approve([bank.address, lpAmount], { account: admin.account });
        await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });

        const players = (await viem.getWalletClients()).slice(0, 6);

        const betPer = parseUnits("1", 6);
        const betData = encodeSingleBet(1n, 7n, betPer);

        await runLaneUntilStable({ scheduler, lanes: [0n], rounds: 5 });

        for (const p of players) {
            await asset.write.mint([p.account.address, parseUnits("1000", 6)]);
            await asset.write.approve([bank.address, parseUnits("1000", 6)], { account: p.account });
            await bank.write.placeBet([betPer, betData], { account: p.account });
        }

        await time.increase(550);
        await runLaneUntilStable({ scheduler, lanes: [0n], rounds: 20 });
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);

        await runParallelLanesUntilIdle(scheduler, { maxIters: 800 });

        const st = await engine.read.marketRoundStateByRound([1n, 1n]);
        const settledOut = Array.isArray(st) ? Boolean(st[3]) : Boolean((st as { settled: boolean }).settled);
        expect(settledOut).to.equal(true);
        expect(await engine.read.roundPhase([1n])).to.equal(4n);
    });

    it("settles with a larger per-call payout chunk", async function () {
        const { admin, vrf, scheduler, bank, asset, engine } = await deploySingleMarket({
            maxPayoutsPerCall: 3,
        });

        const wallets = await viem.getWalletClients();
        const p1 = wallets[1]!;
        const lpAmount = parseUnits("5000", 6);
        await asset.write.mint([admin.account.address, lpAmount], { account: admin.account });
        await asset.write.approve([bank.address, lpAmount], { account: admin.account });
        await bank.write.deposit([lpAmount, admin.account.address], { account: admin.account });
        await asset.write.mint([p1.account.address, parseUnits("1000", 6)]);
        await asset.write.approve([bank.address, parseUnits("1000", 6)], { account: p1.account });

        await runLaneUntilStable({ scheduler, lanes: [0n], rounds: 5 });
        await bank.write.placeBet([parseUnits("1", 6), encodeSingleBet(1n, 7n, parseUnits("1", 6))], {
            account: p1.account,
        });

        await time.increase(550);
        await runLaneUntilStable({ scheduler, lanes: [0n], rounds: 30 });
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 1n]);
        await runParallelLanesUntilIdle(scheduler, { maxIters: 200 });

        const st = await engine.read.marketRoundStateByRound([1n, 1n]);
        const settledOut = Array.isArray(st) ? Boolean(st[3]) : Boolean((st as { settled: boolean }).settled);
        expect(settledOut).to.equal(true);
    });
});
