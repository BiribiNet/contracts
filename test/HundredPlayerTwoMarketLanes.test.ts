import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, keccak256, parseEther, parseUnits, stringToHex, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { decodeRoulettePerformData } from "./helpers/decodeUpkeepPerformData";
import {
    DEFAULT_PAYOUT_LANE_COUNT,
    fulfillVrfForGlobalRound,
    laneCheckData,
    runParallelLanesUntilGlobalRound,
    runParallelLanesUntilIdle,
    runParallelLanesUntilMarketsSettled,
    runParallelLanesUntilVrfPending,
} from "./helpers/parallelUpkeep";

/** Production-shaped automation: 10 payout lanes, scheduler caps aligned with Arbitrum Sepolia deploy. */
const LANE_COUNT = DEFAULT_PAYOUT_LANE_COUNT;
const MAX_PAYOUTS_PER_CALL = 60;
const SCAN_LIMIT = 25;

const PLAYER_COUNT = 110;
const PLAYERS_PER_MARKET = PLAYER_COUNT / 2;
const WINNING_NUMBER = 7n;
const STRAIGHT = 1n;
const STAKE = parseUnits("5", 6);
const MARKET_IDS = [1, 2] as const;

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

function playerPrivateKey(index: number): Hex {
    return keccak256(stringToHex(`hundred-player-two-market-${index}`));
}

/** Market index 0 → on-chain marketId 1, index 1 → marketId 2. */
function marketIndexForPlayer(index: number) {
    return index < PLAYERS_PER_MARKET ? 0 : 1;
}

function expectedBalanceAfterStraightWin(mintEach: bigint, wins: number, losingStakes = 0): bigint {
    return mintEach + STAKE * 35n * BigInt(wins) - STAKE * BigInt(losingStakes);
}

async function deployTwoMarketProductionLanes() {
    const [admin] = await viem.getWalletClients();
    const asset0 = await viem.deployContract("MockUSDC");
    const asset1 = await viem.deployContract("MockUSDC");
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
        { admin: admin.account.address, scanLimit: SCAN_LIMIT, maxPayoutsPerCall: MAX_PAYOUTS_PER_CALL },
        {
            protocolPrefix: {
                brb: brb.address,
                mockRouter: mockRouter.address,
                admin: admin.account.address,
            },
        },
    );
    expect(await engine.read.payoutParallelLaneCount()).to.equal(LANE_COUNT);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket([{ asset: asset0.address, bankAdmin: admin.account.address,

 minBet: 1_000_000n }], {
        account: admin.account,
    });
    await registry.write.createMarket([{ asset: asset1.address, bankAdmin: admin.account.address,

 minBet: 1_000_000n }], {
        account: admin.account,
    });

    const bank0 = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    const bank1 = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([2])).bank);

    return { admin, vrf, engine, scheduler, asset0, asset1, bank0, bank1 };
}

async function fundLiquidity(
    admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0],
    tokens: readonly [{ write: { mint: Function; approve: Function } }, { write: { mint: Function; approve: Function } }],
    banks: readonly [{ write: { deposit: Function } }, { write: { deposit: Function } }],
) {
    const lp = parseUnits("500000", 6);
    for (let i = 0; i < 2; i++) {
        await tokens[i].write.mint([admin.account.address, lp], { account: admin.account });
        await tokens[i].write.approve([banks[i].address, lp], { account: admin.account });
        await banks[i].write.deposit([lp, admin.account.address], { account: admin.account });
    }
}

async function placeBetsForRound(opts: {
    testClient: Awaited<ReturnType<typeof viem.getTestClient>>;
    banks: readonly [{ write: { placeBet: Function } }, { write: { placeBet: Function } }];
    tokens: readonly [{ write: { mint: Function; approve: Function } }, { write: { mint: Function; approve: Function } }];
    numberForMarket: (marketIndex: 0 | 1) => bigint;
    /** When false, players keep round-1 balances and only approve/spend for the new stake. */
    fundPlayers?: boolean;
}) {
    const mintEach = parseUnits("2000", 6);
    const straight = (n: bigint) => encodeSingleBet(STRAIGHT, n, STAKE);
    const fundPlayers = opts.fundPlayers ?? true;

    for (let i = 0; i < PLAYER_COUNT; i++) {
        const account = privateKeyToAccount(playerPrivateKey(i));
        await opts.testClient.setBalance({ address: account.address, value: parseEther("2") });

        const m = marketIndexForPlayer(i) as 0 | 1;
        const number = opts.numberForMarket(m);
        if (fundPlayers) {
            await opts.tokens[m].write.mint([account.address, mintEach], { account });
        }
        await opts.tokens[m].write.approve([opts.banks[m].address, mintEach], { account });
        await opts.banks[m].write.placeBet([STAKE, straight(number), zeroAddress], { account });
    }
}

async function countLanesWithPayoutWork(
    scheduler: { read: { checkUpkeep: (args: [`0x${string}`]) => Promise<[boolean, `0x${string}`]> } },
    roundId: bigint,
    marketId: number,
) {
    let lanes = 0;
    for (let lane = 0; lane < Number(LANE_COUNT); lane++) {
        const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(BigInt(lane))]);
        if (!needed) continue;
        const decoded = decodeRoulettePerformData(performData);
        if (decoded.jobKind !== 2 || decoded.marketId !== marketId) continue;
        lanes++;
        expect(decoded.roundId).to.equal(roundId);
        expect(decoded.lane).to.equal(lane);
        expect(decoded.shardIndex).to.equal(lane);
        expect(decoded.shardWidth).to.equal(Number(LANE_COUNT));
    }
    return lanes;
}

describe("Hundred-player two-market lane stress", function () {
    it("settles 110 same-number straight bets across two markets with 10 lanes; alternates sweep order between rounds", async function () {
        this.timeout(600_000);

        const testClient = await viem.getTestClient();
        const publicClient = await viem.getPublicClient();
        const { vrf, engine, scheduler, asset0, asset1, bank0, bank1 } = await deployTwoMarketProductionLanes();
        const banks = [bank0, bank1] as const;
        const tokens = [asset0, asset1] as const;

        await fundLiquidity((await viem.getWalletClients())[0], tokens, banks);
        await runParallelLanesUntilIdle(scheduler);

        const mintEach = parseUnits("2000", 6);

        // —— Round 1: everyone hits 7 on both markets; forward lane sweep (0 → 9) ——
        await placeBetsForRound({
            testClient,
            banks,
            tokens,
            numberForMarket: () => WINNING_NUMBER,
        });

        await time.increase(550);
        await runParallelLanesUntilIdle(scheduler, { maxIters: 400 });

        await runParallelLanesUntilVrfPending(engine, scheduler, { maxIters: 600 });
        await fulfillVrfForGlobalRound(publicClient, vrf, engine, 1n, WINNING_NUMBER);

        const lanesRound1 = await countLanesWithPayoutWork(scheduler, 1n, 1);
        expect(lanesRound1).to.be.greaterThan(1, "multiple lanes should shard market-1 winners");

        const settledRound1 = await runParallelLanesUntilMarketsSettled(engine, scheduler, 1n, [...MARKET_IDS], {
            maxIters: 2500,
            reverseSweep: false,
        });
        const m1SweepR1 = settledRound1.get(1)!;
        const m2SweepR1 = settledRound1.get(2)!;
        expect(m1SweepR1).to.be.at.most(m2SweepR1 + 2, "markets settle in roughly the same sweep window (parallel lanes)");

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            const token = tokens[marketIndexForPlayer(i)];
            expect(await token.read.balanceOf([account.address])).to.equal(expectedBalanceAfterStraightWin(mintEach, 1));
        }

        await runParallelLanesUntilGlobalRound(engine, scheduler, 2n, { maxIters: 3000 });

        // —— Round 2: market 1 misses, market 2 still on 7; reverse lane sweep (9 → 0) ——
        await placeBetsForRound({
            testClient,
            banks,
            tokens,
            numberForMarket: (m) => (m === 0 ? 8n : WINNING_NUMBER),
            fundPlayers: false,
        });
        await time.increase(550);
        await runParallelLanesUntilVrfPending(engine, scheduler, { maxIters: 600, reverseSweep: false });

        const round2Id = await engine.read.currentGlobalRound();
        expect(round2Id).to.equal(2n);

        await fulfillVrfForGlobalRound(publicClient, vrf, engine, round2Id, WINNING_NUMBER);

        const lanesRound2Market2 = await countLanesWithPayoutWork(scheduler, round2Id, 2);
        expect(lanesRound2Market2).to.be.greaterThan(4, "55 winners on market 2 shard across lanes (reverse sweep)");

        await runParallelLanesUntilMarketsSettled(engine, scheduler, round2Id, [1], {
            maxIters: 100,
            reverseSweep: true,
        });

        const settledRound2 = await runParallelLanesUntilMarketsSettled(engine, scheduler, round2Id, [...MARKET_IDS], {
            maxIters: 2500,
            reverseSweep: true,
        });
        const m1SweepR2 = settledRound2.get(1)!;
        const m2SweepR2 = settledRound2.get(2)!;

        expect(m1SweepR2).to.be.at.most(m2SweepR2 + 2, "parallel lanes may finish market 2 before market 1 dust settles");

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            const token = tokens[marketIndexForPlayer(i)];
            const onMarket2 = marketIndexForPlayer(i) === 1;
            expect(await token.read.balanceOf([account.address])).to.equal(
                expectedBalanceAfterStraightWin(mintEach, onMarket2 ? 2 : 1, onMarket2 ? 0 : 1),
            );
        }

        expect(await engine.read.roundPhase([round2Id])).to.equal(4n);
    });

    it("round 2 with all 110 winners on market 2 only — lanes exclusively settle the heavy market", async function () {
        this.timeout(600_000);

        const testClient = await viem.getTestClient();
        const publicClient = await viem.getPublicClient();
        const { admin, vrf, engine, scheduler, asset0, asset1, bank0, bank1 } = await deployTwoMarketProductionLanes();
        const banks = [bank0, bank1] as const;
        const tokens = [asset0, asset1] as const;

        await fundLiquidity(admin, tokens, banks);
        await runParallelLanesUntilIdle(scheduler);

        const mintEach = parseUnits("2000", 6);
        const straight7 = encodeSingleBet(STRAIGHT, WINNING_NUMBER, STAKE);

        // Round 1: split 55 / 55 on winning straight (baseline).
        await placeBetsForRound({
            testClient,
            banks,
            tokens,
            numberForMarket: () => WINNING_NUMBER,
        });
        await time.increase(550);
        await runParallelLanesUntilIdle(scheduler, { maxIters: 400 });
        await runParallelLanesUntilVrfPending(engine, scheduler, { maxIters: 600 });
        await fulfillVrfForGlobalRound(publicClient, vrf, engine, 1n, WINNING_NUMBER);
        await runParallelLanesUntilMarketsSettled(engine, scheduler, 1n, [...MARKET_IDS], { maxIters: 2500 });
        await runParallelLanesUntilGlobalRound(engine, scheduler, 2n, { maxIters: 3000 });

        // Round 2: dust on market 1 (losing), all 110 players on market 2 winning straight.
        await asset0.write.mint([admin.account.address, STAKE], { account: admin.account });
        await asset0.write.approve([bank0.address, STAKE], { account: admin.account });
        await bank0.write.placeBet([STAKE, encodeSingleBet(STRAIGHT, 8n, STAKE), zeroAddress], { account: admin.account });

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            await testClient.setBalance({ address: account.address, value: parseEther("2") });
            const playedMarket2InRound1 = marketIndexForPlayer(i) === 1;
            if (!playedMarket2InRound1) {
                await asset1.write.mint([account.address, mintEach], { account });
            }
            await asset1.write.approve([bank1.address, mintEach], { account });
            await bank1.write.placeBet([STAKE, straight7, zeroAddress], { account });
        }

        await time.increase(550);
        await runParallelLanesUntilVrfPending(engine, scheduler, { maxIters: 600, reverseSweep: true });
        const round2Id = 2n;
        await fulfillVrfForGlobalRound(publicClient, vrf, engine, round2Id, WINNING_NUMBER);

        const lanesOnMarket2 = await countLanesWithPayoutWork(scheduler, round2Id, 2);
        expect(lanesOnMarket2).to.be.greaterThan(4, "110 winners on market 2 should fan out across lanes");

        await runParallelLanesUntilMarketsSettled(engine, scheduler, round2Id, [1], { maxIters: 100, reverseSweep: true });

        const settled = await runParallelLanesUntilMarketsSettled(engine, scheduler, round2Id, [...MARKET_IDS], {
            maxIters: 2500,
            reverseSweep: true,
        });
        expect(settled.get(1)).to.be.at.most(settled.get(2)! + 2, "market 1 (dust loser) and market 2 settle in parallel");

        for (let i = 0; i < PLAYER_COUNT; i++) {
            const account = privateKeyToAccount(playerPrivateKey(i));
            const playedMarket2InRound1 = marketIndexForPlayer(i) === 1;
            const expected = playedMarket2InRound1
                ? expectedBalanceAfterStraightWin(mintEach, 2)
                : expectedBalanceAfterStraightWin(mintEach, 1);
            expect(await asset1.read.balanceOf([account.address])).to.equal(expected);
        }
    });
});
