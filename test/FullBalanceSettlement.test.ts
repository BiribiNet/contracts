import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { type Address } from "viem";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeAbiParameters, parseUnits } from "viem";

/** Matches `RouletteEngine.sol` INFRA_BPS constant. */
const INFRA_BPS = 250n;
const SW_BPS_DENOM = 10_000n;

/** Mock router BRB balance for swaps (within `BRBToken.TOTAL_SUPPLY`). */
const ROUTER_BRB_LIQUIDITY = parseUnits("2000000", 18);

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

function extractJackpotTriggered(globalRoundTuple: unknown): boolean {
    if (typeof globalRoundTuple === "object" && globalRoundTuple !== null && "jackpotTriggered" in globalRoundTuple) {
        return Boolean((globalRoundTuple as { jackpotTriggered: boolean }).jackpotTriggered);
    }
    if (Array.isArray(globalRoundTuple)) {
        return Boolean(globalRoundTuple[4]);
    }
    throw new Error("unexpected globalRoundState shape");
}

async function deploySingleMarketSettlement(opts?: { treasuryBrbSeed?: bigint; maxPayoutsPerCall?: number }) {
    const [admin, alice, bob, carol] = await viem.getWalletClients();

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
    const engine = await deployRouletteEngine([
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

    await funder.write.setBrbPerAssetUnitRatio([1n, 10n ** 30n], { account: admin.account });

    await brb.write.transfer([mockRouter.address, ROUTER_BRB_LIQUIDITY], { account: admin.account });

    const treasuryBrbSeed = opts?.treasuryBrbSeed ?? 0n;
    if (treasuryBrbSeed > 0n) {
        await brb.write.transfer([jackpotTreasury.address, treasuryBrbSeed], { account: admin.account });
    }

    const maxPayouts = opts?.maxPayoutsPerCall ?? 50;
    const scheduler = await viem.deployContract("UpkeepScheduler", [
        engine.address,
        admin.account.address,
        20,
        maxPayouts,
    ]);
    await engine.write.registerScheduler([scheduler.address, true]);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
        [{ asset: usdc.address, bankName: "Bank", bankSymbol: "b", bankAdmin: admin.account.address }],
        { account: admin.account },
    );
    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    return {
        admin,
        alice,
        bob,
        carol,
        usdc,
        brb,
        vrf,
        engine,
        scheduler,
        bank,
        jackpotTreasury,
        mockRouter,
        funder,
    };
}

async function performOneUpkeep(scheduler: any, lane: bigint) {
    const checkData =
        lane === 0n ? ("0x" as const) : encodeAbiParameters([{ type: "uint256" }], [lane]);
    const [needed, performData] = await scheduler.read.checkUpkeep([checkData]);
    if (!needed) return false;
    await scheduler.write.performUpkeep([performData]);
    return true;
}

async function runSchedulerUntilIdle(scheduler: any, maxIters = 500) {
    for (let i = 0; i < maxIters; i++) {
        const progressed = await performOneUpkeep(scheduler, 0n);
        if (!progressed) break;
    }
}

describe("Full balance settlement (players, jackpot BRB, LP stakers)", function () {
    it("balances + LP NAV: loser-only round funds infra, swap BRB slices, vault pays stakers consistently", async function () {
        const ctx = await deploySingleMarketSettlement({ treasuryBrbSeed: 0n });
        const { admin, alice, carol, usdc, brb, vrf, engine, scheduler, bank, jackpotTreasury, funder } = ctx;

        const lpDeposit = parseUnits("50000", 6);
        await usdc.write.mint([carol.account.address, lpDeposit]);
        await usdc.write.approve([bank.address, lpDeposit], { account: carol.account });
        await bank.write.deposit([lpDeposit, carol.account.address], { account: carol.account });
        const carolShares = await bank.read.balanceOf([carol.account.address]);

        const bet = parseUnits("10", 6);
        await usdc.write.mint([alice.account.address, parseUnits("500", 6)]);
        await usdc.write.approve([bank.address, bet], { account: alice.account });

        await runSchedulerUntilIdle(scheduler);

        await bank.write.placeBet([bet, encodeSingleBet(1n, 8n, bet)], { account: alice.account });
        await time.increase(550);

        await runSchedulerUntilIdle(scheduler);
        await vrf.write.fulfill([engine.address, 1n, 7n]);
        await runSchedulerUntilIdle(scheduler);

        expect(await engine.read.roundPhase([1n])).to.equal(4n);

        const marketWin = bet;
        const swapIn = (marketWin * (await funder.read.swapAssetTotalBps())) / SW_BPS_DENOM;
        const infraFee = (marketWin * INFRA_BPS) / SW_BPS_DENOM;
        expect(swapIn + infraFee).to.be.lt(marketWin);

        const vaultUsdcBal = await usdc.read.balanceOf([bank.address]);
        expect(vaultUsdcBal).to.be.closeTo(lpDeposit + bet - swapIn - infraFee, 3n);
        expect(await bank.read.totalAssets()).to.equal(vaultUsdcBal);
        expect(await bank.read.lockedBetLiquidity()).to.equal(0n);

        expect(await bank.read.convertToAssets([carolShares])).to.be.closeTo(vaultUsdcBal, 5n);

        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(parseUnits("500", 6) - bet);

        expect(await usdc.read.balanceOf([admin.account.address])).to.equal(infraFee);

        const brbOut = swapIn * 10n ** 12n;
        const treasuryNum = await funder.read.treasuryBrbNumerator();
        const treasuryDen = await funder.read.treasuryBrbDenominator();
        const toTreasury = (brbOut * treasuryNum) / treasuryDen;
        const toBurn = brbOut - toTreasury;
        const dead = "0x000000000000000000000000000000000000dEaD" as Address;

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(toTreasury);
        expect(await brb.read.balanceOf([dead])).to.equal(toBurn);

        const usdcSupply = await usdc.read.totalSupply();
        const brbSupply = await brb.read.totalSupply();
        await runSchedulerUntilIdle(scheduler);
        expect(await usdc.read.totalSupply()).to.equal(usdcSupply);
        expect(await brb.read.totalSupply()).to.equal(brbSupply);

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(toTreasury);
    });

    it("balances: winning straight pays USDC correctly; proportional jackpot BRB to two winners; vault + two LPs", async function () {
        const treasurySeed = parseUnits("777", 18);
        const ctx = await deploySingleMarketSettlement({ treasuryBrbSeed: treasurySeed, maxPayoutsPerCall: 50 });

        const { alice, bob, usdc, brb, vrf, engine, scheduler, bank, jackpotTreasury } = ctx;

        const walletClients = await viem.getWalletClients();
        const dave = walletClients[4];
        if (!dave) throw new Error("expected wallet index 4 (dave)");

        const lpAlice = parseUnits("30000", 6);
        const lpDave = parseUnits("20000", 6);
        await usdc.write.mint([alice.account.address, lpAlice]);
        await usdc.write.mint([dave.account.address, lpDave]);
        await usdc.write.approve([bank.address, lpAlice], { account: alice.account });
        await usdc.write.approve([bank.address, lpDave], { account: dave.account });

        await bank.write.deposit([lpAlice, alice.account.address], { account: alice.account });
        await bank.write.deposit([lpDave, dave.account.address], { account: dave.account });

        const sharesA = await bank.read.balanceOf([alice.account.address]);
        const sharesD = await bank.read.balanceOf([dave.account.address]);
        expect(sharesA + sharesD).to.equal(await bank.read.totalSupply());

        const mintExtraAlice = parseUnits("2000", 6);
        const mintExtraBob = parseUnits("2000", 6);
        await usdc.write.mint([alice.account.address, mintExtraAlice]);
        await usdc.write.mint([bob.account.address, mintExtraBob]);

        await runSchedulerUntilIdle(scheduler);

        const betAlice = parseUnits("10", 6);
        const betBob = parseUnits("30", 6);
        await usdc.write.approve([bank.address, betAlice + betBob], { account: alice.account });
        await usdc.write.approve([bank.address, betAlice + betBob], { account: bob.account });

        await bank.write.placeBet([betAlice, encodeSingleBet(1n, 7n, betAlice)], { account: alice.account });
        await bank.write.placeBet([betBob, encodeSingleBet(1n, 7n, betBob)], { account: bob.account });
        await time.increase(550);

        await runSchedulerUntilIdle(scheduler);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);
        await runSchedulerUntilIdle(scheduler);

        expect(await engine.read.roundPhase([1n])).to.equal(4n);
        const gr = await engine.read.globalRoundState([1n]);
        expect(extractJackpotTriggered(gr)).to.equal(true);

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(0n);

        const grossAlice = betAlice * 36n;
        const grossBob = betBob * 36n;

        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(
            mintExtraAlice - betAlice + grossAlice,
        );

        expect(await usdc.read.balanceOf([bob.account.address])).to.equal(mintExtraBob - betBob + grossBob);

        const ratioScale = 10n ** 18n;
        const ratioPerAsset = 10n ** 30n;
        const stakeA = (betAlice * ratioPerAsset) / ratioScale;
        const stakeB = (betBob * ratioPerAsset) / ratioScale;
        const denom = stakeA + stakeB;

        const shareA = (treasurySeed * stakeA) / denom;
        const shareB = treasurySeed - shareA;

        expect(await brb.read.balanceOf([alice.account.address])).to.equal(shareA);
        expect(await brb.read.balanceOf([bob.account.address])).to.equal(shareB);
        expect(shareA + shareB).to.equal(treasurySeed);

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(0n);

        const totalBets = betAlice + betBob;
        const bankPaid = grossAlice + grossBob;
        expect(totalBets < bankPaid).to.equal(true);

        const expectedVault = lpAlice + lpDave + totalBets - bankPaid;
        const vaultUsdcBal = await usdc.read.balanceOf([bank.address]);

        expect(vaultUsdcBal).to.equal(expectedVault);
        expect(await bank.read.lockedBetLiquidity()).to.equal(0n);
        expect(await bank.read.totalAssets()).to.equal(expectedVault);

        const navA = await bank.read.convertToAssets([sharesA]);
        const navD = await bank.read.convertToAssets([sharesD]);
        expect(navA + navD).to.equal(expectedVault);

        const lpTotal = lpAlice + lpDave;
        const expectNavA = (expectedVault * lpAlice) / lpTotal;
        const expectNavD = (expectedVault * lpDave) / lpTotal;
        expect(navA).to.be.closeTo(expectNavA, parseUnits("2", 6));
        expect(navD).to.be.closeTo(expectNavD, parseUnits("2", 6));
    });

    it("USDC totalSupply invariant (no burns/mints mid-round): loser round only moves liquidity between actors", async function () {
        const ctx = await deploySingleMarketSettlement({ treasuryBrbSeed: 0n });

        const { admin, alice, carol, usdc, brb, vrf, engine, scheduler, bank } = ctx;

        await usdc.write.mint([carol.account.address, parseUnits("40000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("40000", 6)], { account: carol.account });
        await bank.write.deposit([parseUnits("40000", 6), carol.account.address], { account: carol.account });

        const bobBet = parseUnits("8", 6);
        await usdc.write.mint([alice.account.address, bobBet]);
        await usdc.write.approve([bank.address, bobBet], { account: alice.account });

        await runSchedulerUntilIdle(scheduler);

        await bank.write.placeBet([bobBet, encodeSingleBet(1n, 2n, bobBet)], { account: alice.account });
        await time.increase(550);

        const usdcSupplyBefore = await usdc.read.totalSupply();
        const brbSupplyBefore = await brb.read.totalSupply();

        await runSchedulerUntilIdle(scheduler);
        await vrf.write.fulfill([engine.address, 1n, 7n]);
        await runSchedulerUntilIdle(scheduler);

        expect(await engine.read.roundPhase([1n])).to.equal(4n);
        expect(await usdc.read.totalSupply()).to.equal(usdcSupplyBefore);
        expect(await brb.read.totalSupply()).to.equal(brbSupplyBefore);

        expect(await usdc.read.balanceOf([admin.account.address])).to.be.gt(0n);
    });
});
