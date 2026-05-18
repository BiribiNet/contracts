import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { viem } from "hardhat";
import { encodeAbiParameters, parseUnits } from "viem";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

const JACKPOT_POOL = parseUnits("1000", 18);
/** Equal normalized jackpot stake per market (see bet sizing below). */
const EXPECTED_SHARE = JACKPOT_POOL / 3n;
/** BRB payout rounding across three winners (last winner absorbs remainder). */
const SHARE_TOLERANCE = 10n ** 12n;

function extractJackpotPaid(globalRoundTuple: unknown): bigint {
    if (typeof globalRoundTuple === "object" && globalRoundTuple !== null && "jackpotPaid" in globalRoundTuple) {
        return (globalRoundTuple as { jackpotPaid: bigint }).jackpotPaid;
    }
    if (Array.isArray(globalRoundTuple)) {
        return globalRoundTuple[7] as bigint;
    }
    throw new Error("unexpected globalRoundState shape");
}

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deployThreeMarketJackpotStack() {
    const [admin, alice, bob, carol] = await viem.getWalletClients();

    const usdc = await viem.deployContract("MockUSDC");
    const mockDai = await viem.deployContract("MockUSDC");
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
        { admin: admin.account.address, scanLimit: 10, maxPayoutsPerCall: 50 },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });

    await brb.write.transfer([jackpotTreasury.address, JACKPOT_POOL], { account: admin.account });
    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket([{ asset: usdc.address, bankAdmin: admin.account.address }], {
        account: admin.account,
    });
    await registry.write.createMarket([{ asset: mockDai.address, bankAdmin: admin.account.address }], {
        account: admin.account,
    });
    await registry.write.createMarket([{ asset: brb.address, bankAdmin: admin.account.address }], {
        account: admin.account,
    });

    const bankUsdc = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    const bankDai = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([2])).bank);
    const bankBrb = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([3])).bank);

    const lp = parseUnits("50000", 6);
    const lpBrb = parseUnits("50000", 18);
    await usdc.write.mint([admin.account.address, lp]);
    await usdc.write.approve([bankUsdc.address, lp], { account: admin.account });
    await bankUsdc.write.deposit([lp, admin.account.address], { account: admin.account });
    await mockDai.write.mint([admin.account.address, lp]);
    await mockDai.write.approve([bankDai.address, lp], { account: admin.account });
    await bankDai.write.deposit([lp, admin.account.address], { account: admin.account });
    await brb.write.approve([bankBrb.address, lpBrb], { account: admin.account });
    await bankBrb.write.deposit([lpBrb, admin.account.address], { account: admin.account });

    return {
        admin,
        alice,
        bob,
        carol,
        usdc,
        mockDai,
        brb,
        vrf,
        engine,
        scheduler,
        bankUsdc,
        bankDai,
        bankBrb,
        jackpotTreasury,
    };
}

describe("Jackpot multi-market proportional split", function () {
    it("splits 1000 BRB ~1/3 each across USDC, mock DAI, and BRB straight winners", async function () {
        const {
            admin,
            alice,
            bob,
            carol,
            usdc,
            mockDai,
            brb,
            vrf,
            engine,
            scheduler,
            bankUsdc,
            bankDai,
            bankBrb,
            jackpotTreasury,
        } = await deployThreeMarketJackpotStack();

        const betUsdc = parseUnits("100", 6);
        const betDai = parseUnits("100", 6);
        // Same normalized jackpot weight as 100e6 * 1e30 / 1e18 when BRB uses 1e18 ratio on 18-decimal asset.
        const betBrb = parseUnits("100", 18);

        await usdc.write.mint([alice.account.address, parseUnits("10000", 6)]);
        await mockDai.write.mint([bob.account.address, parseUnits("10000", 6)]);
        await brb.write.transfer([carol.account.address, parseUnits("10000", 18)], { account: admin.account });
        await usdc.write.approve([bankUsdc.address, parseUnits("10000", 6)], { account: alice.account });
        await mockDai.write.approve([bankDai.address, parseUnits("10000", 6)], { account: bob.account });
        await brb.write.approve([bankBrb.address, parseUnits("10000", 18)], { account: carol.account });

        const brbBeforeAlice = await brb.read.balanceOf([alice.account.address]);
        const brbBeforeBob = await brb.read.balanceOf([bob.account.address]);
        const brbBeforeCarol = await brb.read.balanceOf([carol.account.address]);

        await bankUsdc.write.placeBet([betUsdc, encodeSingleBet(1n, 7n, betUsdc)], { account: alice.account });
        await bankDai.write.placeBet([betDai, encodeSingleBet(1n, 7n, betDai)], { account: bob.account });
        await bankBrb.write.placeBet([betBrb, encodeSingleBet(1n, 7n, betBrb)], { account: carol.account });

        await time.increase(550);
        await runParallelLanesUntilIdle(scheduler);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);
        await runParallelLanesUntilIdle(scheduler);

        expect(await jackpotTreasury.read.jackpotPool()).to.equal(0n);

        const gr = await engine.read.globalRoundState([1n]);
        const jackpotTriggered =
            typeof gr === "object" && gr !== null && "jackpotTriggered" in gr
                ? Boolean((gr as { jackpotTriggered: boolean }).jackpotTriggered)
                : Boolean((gr as readonly unknown[])[4]);
        expect(jackpotTriggered).to.equal(true);

        expect(extractJackpotPaid(gr)).to.equal(JACKPOT_POOL);

        const straightWinBrb = betBrb * 36n;
        const brbAfterAlice = await brb.read.balanceOf([alice.account.address]);
        const brbAfterBob = await brb.read.balanceOf([bob.account.address]);
        const brbAfterCarol = await brb.read.balanceOf([carol.account.address]);

        // Alice/Bob only touch BRB via jackpot; Carol also posts and wins on the BRB market.
        const jackpotAlice = brbAfterAlice - brbBeforeAlice;
        const jackpotBob = brbAfterBob - brbBeforeBob;
        const jackpotCarol = brbAfterCarol - brbBeforeCarol + betBrb - straightWinBrb;

        console.log("jackpotAlice", jackpotAlice);
        console.log("jackpotBob", jackpotBob);
        console.log("jackpotCarol", jackpotCarol);
        expect(jackpotAlice + jackpotBob + jackpotCarol).to.equal(JACKPOT_POOL);

        for (const paid of [jackpotAlice, jackpotBob, jackpotCarol]) {
            const diff = paid > EXPECTED_SHARE ? paid - EXPECTED_SHARE : EXPECTED_SHARE - paid;
            expect(diff).to.be.lte(SHARE_TOLERANCE);
        }
    });
});
