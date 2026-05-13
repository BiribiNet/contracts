import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import {
    encodeAbiParameters,
    keccak256,
    parseEther,
    parseUnits,
    stringToHex,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** One global round across two ERC-20 markets, 50 players; payouts chunked via a single upkeep lane. */

const PLAYER_COUNT = 50;
const WINNING_NUMBER = 7n;

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

function playerPrivateKey(index: number): Hex {
    return keccak256(stringToHex(`multi-market-crowd-player-${index}`));
}

/** Deterministic wager mix across outside / inside bets so validation always passes onchain. */
function betForPlayer(index: number): { amount: bigint; data: Hex } {
    const bump = BigInt(index % 4) * parseUnits("1", 6);
    const stake = parseUnits("4", 6) + bump;
    const mode = index % 8;
    let data: Hex;
    switch (mode) {
        case 0:
            data = encodeSingleBet(1n, BigInt(index % 37), stake);
            break; // STRAIGHT
        case 1:
            data = encodeSingleBet(8n, 0n, stake);
            break; // RED (7 is red)
        case 2:
            data = encodeSingleBet(9n, 0n, stake);
            break; // BLACK
        case 3:
            data = encodeSingleBet(10n, 0n, stake);
            break; // ODD (7 wins)
        case 4:
            data = encodeSingleBet(11n, 0n, stake);
            break; // EVEN
        case 5:
            data = encodeSingleBet(3n, 1n + BigInt(Math.floor(index / 8) % 11) * 3n, stake);
            break; // STREET starts 1..31
        case 6:
            data = encodeSingleBet(6n, 1n + BigInt(index % 3), stake);
            break; // COLUMN
        default:
            data = encodeSingleBet(7n, 1n + BigInt(index % 3), stake);
            break; // DOZEN
    }
    return { amount: stake, data };
}

function marketForPlayer(index: number) {
    return index < PLAYER_COUNT / 2 ? 0 : 1;
}

function stakeFor(index: number) {
    const bump = BigInt(index % 4) * parseUnits("1", 6);
    return parseUnits("4", 6) + bump;
}

/** Mirrors `RouletteEngine._payoutForBet` for our fixed bet shapes when `WINNING_NUMBER` hits. */
function expectedGrossPayout(index: number): bigint {
    const amount = stakeFor(index);
    const mode = index % 8;

    switch (mode) {
        case 0: {
            const n = BigInt(index % 37);
            return n === WINNING_NUMBER ? amount * 36n : 0n;
        }
        case 1:
            return amount * 2n; // RED (7 is red on this layout)
        case 2:
            return 0n; // BLACK
        case 3:
            return amount * 2n; // ODD
        case 4:
            return 0n; // EVEN
        case 5: {
            const streetStart = 1n + BigInt(Math.floor(index / 8) % 11) * 3n;
            const winningStreet = ((WINNING_NUMBER - 1n) / 3n) * 3n + 1n;
            return streetStart === winningStreet ? amount * 12n : 0n;
        }
        case 6: {
            const playerCol = 1n + BigInt(index % 3);
            const winningCol = ((WINNING_NUMBER - 1n) % 3n) + 1n;
            return playerCol === winningCol ? amount * 3n : 0n;
        }
        default: {
            const playerDoz = 1n + BigInt(index % 3);
            const winningDoz = (WINNING_NUMBER - 1n) / 12n + 1n;
            return playerDoz === winningDoz ? amount * 3n : 0n;
        }
    }
}

function expectedTokenBalance(index: number, mintEach: bigint) {
    const stake = stakeFor(index);
    return mintEach - stake + expectedGrossPayout(index);
}

async function deployTwoMarketSchedulerStack(opts: { maxPayoutsPerCall: number; scanLimit: number }) {
    const [admin] = await viem.getWalletClients();
    const asset0 = await viem.deployContract("MockUSDC");
    const asset1 = await viem.deployContract("MockUSDC");
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
        { admin: admin.account.address, scanLimit: opts.scanLimit, maxPayoutsPerCall: opts.maxPayoutsPerCall },
    );

    await jackpotTreasury.write.setEngine([engine.address]);
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address], { account: admin.account });

    const ratio = 10n ** 30n;
    await funder.write.setBrbPerAssetUnitRatio([1n, ratio], { account: admin.account });
    await funder.write.setBrbPerAssetUnitRatio([2n, ratio], { account: admin.account });

    await brb.write.transfer([mockRouter.address, parseUnits("2000000", 18)], { account: admin.account });

    expect(await engine.read.payoutParallelLaneCount()).to.equal(1);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
        [{ asset: asset0.address, bankName: "Bank A", bankSymbol: "bA", bankAdmin: admin.account.address }],
        { account: admin.account },
    );
    await registry.write.createMarket(
        [{ asset: asset1.address, bankName: "Bank B", bankSymbol: "bB", bankAdmin: admin.account.address }],
        { account: admin.account },
    );

    const cfg0 = await registry.read.getMarket([1]);
    const cfg1 = await registry.read.getMarket([2]);
    const bank0 = await viem.getContractAt("BankVault4626", cfg0.bank);
    const bank1 = await viem.getContractAt("BankVault4626", cfg1.bank);

    return { admin, vrf, engine, scheduler, registry, asset0, asset1, bank0, bank1, brb };
}

async function runSchedulerUntilIdle(scheduler: { read: any; write: any }, maxIters = 6000) {
    for (let i = 0; i < maxIters; i++) {
        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        if (!needed) return;
        await scheduler.write.performUpkeep([performData]);
    }
    throw new Error(`upkeep loop did not converge within ${maxIters} scans`);
}

describe("multi-market crowd (50 players, sequential upkeep)", function () {
    it("settles one global round with varied bets across two banks", async function () {
        this.timeout(120_000);

        const testClient = await viem.getTestClient();
        const { admin, vrf, engine, scheduler, asset0, asset1, bank0, bank1 } = await deployTwoMarketSchedulerStack({
            maxPayoutsPerCall: 20,
            scanLimit: 80,
        });

        await runSchedulerUntilIdle(scheduler);

        const lp = parseUnits("250000", 6);
        for (const { token, bank } of [
            { token: asset0, bank: bank0 },
            { token: asset1, bank: bank1 },
        ]) {
            await token.write.mint([admin.account.address, lp], { account: admin.account });
            await token.write.approve([bank.address, lp], { account: admin.account });
            await bank.write.deposit([lp, admin.account.address], { account: admin.account });
        }

        const mintEach = parseUnits("500", 6);
        const banks = [bank0, bank1] as const;
        const tokens = [asset0, asset1] as const;

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            await testClient.setBalance({ address: account.address, value: parseEther("2") });

            const m = marketForPlayer(i);
            await tokens[m].write.mint([account.address, mintEach]);
            await tokens[m].write.approve([banks[m].address, mintEach], { account });

            const { amount, data } = betForPlayer(i);
            await banks[m].write.placeBet([amount, data], { account });
        }

        await time.increase(550);
        await runSchedulerUntilIdle(scheduler);

        await vrf.write.fulfill([engine.address, 1n, WINNING_NUMBER]);
        await runSchedulerUntilIdle(scheduler);

        const roundId = 1n;

        const gr = await engine.read.globalRoundState([roundId]);
        const jackpotTriggered = extractJackpotTriggered(gr);
        expect(jackpotTriggered).to.equal(
            false,
            "mock fulfill uses two words whose mods differ; jackpot arms when both VRF words agree mod 37",
        );

        expect(await engine.read.roundPhase([roundId])).to.equal(4n);

        const st0 = await engine.read.marketRoundStateByRound([roundId, 1]);
        const st1 = await engine.read.marketRoundStateByRound([roundId, 2]);
        const settled0 = Array.isArray(st0) ? Boolean(st0[4]) : (st0 as { settled: boolean }).settled;
        const settled1 = Array.isArray(st1) ? Boolean(st1[4]) : (st1 as { settled: boolean }).settled;
        expect(settled0).to.equal(true);
        expect(settled1).to.equal(true);

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            const token = tokens[marketForPlayer(i)];
            expect(await token.read.balanceOf([account.address])).to.equal(expectedTokenBalance(i, mintEach));
        }
    });
});

function extractJackpotTriggered(globalRoundTuple: unknown): boolean {
    if (typeof globalRoundTuple === "object" && globalRoundTuple !== null && "jackpotTriggered" in globalRoundTuple) {
        return Boolean((globalRoundTuple as { jackpotTriggered: boolean }).jackpotTriggered);
    }
    if (Array.isArray(globalRoundTuple)) {
        return Boolean(globalRoundTuple[4]);
    }
    throw new Error("unexpected globalRoundState shape");
}

