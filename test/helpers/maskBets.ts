import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-network-helpers";
import { maxUint256, type Address } from "viem";

import { deployProtocolStack } from "./deployProtocolStack";
import {
    fulfillVrfForGlobalRound,
    runParallelLanesUntilGlobalRound,
    runParallelLanesUntilVrfPending,
} from "./parallelUpkeep";

/** `BET_MASK` (spec `docs/spec-mask-bets-v1.md` §1.3). */
export const BET_MASK = 16n;
export const MASK_BITS = (1n << 37n) - 1n;
export const PRESET_SHIFT = 37n;
export const GUARD_SHIFT = 46n;
export const PREV_SHIFT = 47n;
export const LAUNCH_MAX_LEGS = 1024;
export const LAUNCH_MAX_BPS = 1000;
export const FULL_BPS = 10_000;

export const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function maskOf(numbers: readonly number[]): bigint {
    let mask = 0n;
    for (const n of numbers) mask |= 1n << BigInt(n);
    return mask;
}

export function popcount(mask: bigint): number {
    let count = 0;
    for (let n = 0n; n < 64n; n++) if ((mask >> n) & 1n) count++;
    return count;
}

export type MaskLegOptions = { presetId?: bigint; guard?: boolean; expectedPrev?: bigint };

/** `mask | presetId << 37 | guard << 46 | expectedPrev << 47` (always BigInt: JS bit ops are 32-bit). */
export function encodeMaskNumber(mask: bigint, opts: MaskLegOptions = {}): bigint {
    return mask
        | ((opts.presetId ?? 0n) << PRESET_SHIFT)
        | ((opts.guard ? 1n : 0n) << GUARD_SHIFT)
        | ((opts.expectedPrev ?? 0n) << PREV_SHIFT);
}

export function maskLeg(numbers: readonly number[] | bigint, amount: bigint, opts: MaskLegOptions = {}) {
    const mask = typeof numbers === "bigint" ? numbers : maskOf(numbers);
    return { betType: BET_MASK, number: encodeMaskNumber(mask, opts), amount };
}

export function maskPayout(amount: bigint, size: number): bigint {
    return (amount * 36n) / BigInt(size);
}

/** Payout of a classic leg used by these suites (straight / dozen / column / red / black). */
export function classicPayout(betType: bigint, number: bigint, amount: bigint, winning: number): bigint {
    const w = BigInt(winning);
    switch (betType) {
        case 1n: return number === w ? amount * 36n : 0n;
        case 6n: return winning !== 0 && BigInt(((winning - 1) % 3) + 1) === number ? amount * 3n : 0n;
        case 7n: return winning !== 0 && BigInt(Math.ceil(winning / 12)) === number ? amount * 3n : 0n;
        case 8n: return RED_NUMBERS.has(winning) ? amount * 2n : 0n;
        case 9n: return winning !== 0 && !RED_NUMBERS.has(winning) ? amount * 2n : 0n;
        default: throw new Error(`classicPayout: unsupported bet type ${betType}`);
    }
}

export type RecordedLeg = { player: Address; betType: bigint; number: bigint; amount: bigint };

export function legPayout(leg: RecordedLeg, winning: number): bigint {
    if (leg.betType === BET_MASK) {
        const mask = leg.number & MASK_BITS;
        return (mask >> BigInt(winning)) & 1n ? maskPayout(leg.amount, popcount(mask)) : 0n;
    }
    return classicPayout(leg.betType, leg.number, leg.amount, winning);
}

/** Deterministic PRNG for property tests (mulberry32). */
export function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export type MaskFixtureOptions = {
    decimals?: 6 | 18;
    liquidityUnits?: bigint;
    maxPayoutsPerCall?: number;
    roundDuration?: number;
    maxLegs?: number;
    maxBps?: number;
    laneCount?: number;
    markets?: number;
};

/** Protocol stack with side bets disabled, `markets` vaults (minBet = 1 whole unit) and funded players. */
export async function deployMaskFixture(opts: MaskFixtureOptions = {}) {
    const decimals = opts.decimals ?? 6;
    const roundDuration = opts.roundDuration ?? 600;
    const wallets = await viem.getWalletClients();
    const [admin, alice, bob, carol, stranger] = wallets;
    const stack = await deployProtocolStack({ maxPayoutsPerCall: opts.maxPayoutsPerCall ?? 10, roundDuration });
    await stack.sideBet.write.setSideBetsDisabled([true]);
    if (opts.laneCount !== undefined) await stack.engine.write.setPayoutLaneCount([opts.laneCount]);
    const unit = 10n ** BigInt(decimals);
    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await stack.registry.write.setVaultBeacon([beacon.address]);
    const markets = [];
    for (let id = 1; id <= (opts.markets ?? 1); id++) {
        const token = await viem.deployContract(decimals === 6 ? "MockUSDC" : "MockDAI");
        await stack.registry.write.createMarket([{ asset: token.address, bankAdmin: admin.account.address, minBet: unit }]);
        const bank = await viem.getContractAt("BankVault4626", (await stack.registry.read.getMarket([id])).bank);
        for (const who of [admin, alice, bob, carol, stranger]) {
            await token.write.mint([who.account.address, 10_000_000n * unit]);
            await token.write.approve([bank.address, maxUint256], { account: who.account });
        }
        await bank.write.deposit([(opts.liquidityUnits ?? 100_000n) * unit, admin.account.address]);
        if (opts.maxLegs !== undefined) {
            await stack.engine.write.setMaskBetLimits([id, opts.maxLegs, opts.maxBps ?? FULL_BPS]);
        }
        markets.push({ id, token, bank });
    }
    const publicClient = await viem.getPublicClient();
    return {
        ...stack, admin, alice, bob, carol, stranger, wallets, unit, decimals, roundDuration, publicClient,
        markets, token: markets[0].token, bank: markets[0].bank,
    };
}

export type MaskFixture = Awaited<ReturnType<typeof deployMaskFixture>>;

/** Locks the current round, delivers `winning` and drives every lane until VRF is pending. */
export async function lockAndFulfill(s: MaskFixture, winning: number, jackpotNumber?: number) {
    const roundId = await s.engine.read.currentGlobalRound();
    await time.increase(s.roundDuration + 5);
    const laneCount = BigInt(await s.engine.read.payoutParallelLaneCount());
    await runParallelLanesUntilVrfPending(s.engine, s.scheduler, { laneCount });
    await fulfillVrfForGlobalRound(
        s.publicClient, s.vrf, s.engine, roundId, BigInt(winning),
        jackpotNumber === undefined ? undefined : { jackpotNumber: BigInt(jackpotNumber) },
    );
    return roundId;
}

/** Full settlement of the current round with `winning`; returns the settled round id. */
export async function settleRound(s: MaskFixture, winning: number, jackpotNumber?: number) {
    const roundId = await lockAndFulfill(s, winning, jackpotNumber);
    const laneCount = BigInt(await s.engine.read.payoutParallelLaneCount());
    await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, roundId + 1n, { laneCount });
    return roundId;
}

/** Reads every lane's full preview (cursors at zero) and returns all winner rows. */
export async function previewAllLanes(s: MaskFixture, roundId: bigint, marketId: number) {
    const laneCount = await s.engine.read.payoutParallelLaneCount();
    const rows: { player: Address; amount: bigint; lane: number }[] = [];
    for (let lane = 0; lane < laneCount; lane++) {
        const job = { kind: 2, marketId, roundId, nextCursor: 0, payoutShardIndex: lane, payoutShardWidth: laneCount };
        const [laneRows] = await s.engine.read.previewPayoutBundle([job, 100_000]);
        for (const row of laneRows) rows.push({ player: row.player, amount: row.amount, lane });
    }
    return rows;
}

export function multisetKey(rows: readonly { player: Address; amount: bigint }[]): string[] {
    return rows.map((row) => `${row.player.toLowerCase()}:${row.amount}`).sort();
}
