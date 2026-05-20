import { encodeAbiParameters } from "viem";

export const DEFAULT_PAYOUT_LANE_COUNT = 10n;

export function laneCheckData(lane: bigint) {
    return lane === 0n ? ("0x" as const) : encodeAbiParameters([{ type: "uint256" }], [lane]);
}

export type ParallelScheduler = {
    read: { checkUpkeep: (args: [`0x${string}`]) => Promise<[boolean, `0x${string}`]> };
    write: { performUpkeep: (args: [`0x${string}`]) => Promise<unknown> };
};

export type ParallelRunOpts = {
    laneCount?: bigint;
    maxIters?: number;
    /** When true, each full sweep visits lanes 9 → 0 (production lane count unchanged). */
    reverseSweep?: boolean;
};

function lanesInSweepOrder(laneCount: bigint, reverseSweep: boolean): bigint[] {
    const lanes = Array.from({ length: Number(laneCount) }, (_, i) => BigInt(i));
    return reverseSweep ? lanes.reverse() : lanes;
}

/** Runs check/perform on every payout lane until no lane reports work. */
export async function runParallelLanesUntilIdle(scheduler: ParallelScheduler, opts?: ParallelRunOpts) {
    const laneCount = opts?.laneCount ?? DEFAULT_PAYOUT_LANE_COUNT;
    const maxIters = opts?.maxIters ?? 800;
    const ordered = lanesInSweepOrder(laneCount, opts?.reverseSweep ?? false);

    for (let i = 0; i < maxIters; i++) {
        let progressed = false;
        for (const lane of ordered) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(lane)]);
            if (needed) {
                progressed = true;
                await scheduler.write.performUpkeep([performData]);
            }
        }
        if (!progressed) return;
    }
    throw new Error(`parallel upkeep did not converge within ${maxIters} iterations`);
}

export function extractMarketSettled(marketRoundState: unknown): boolean {
    if (typeof marketRoundState === "object" && marketRoundState !== null && "settled" in marketRoundState) {
        return Boolean((marketRoundState as { settled: boolean }).settled);
    }
    if (Array.isArray(marketRoundState)) {
        return Boolean(marketRoundState[3]);
    }
    throw new Error("unexpected marketRoundState shape");
}

/**
 * Runs parallel lane sweeps until every listed market is settled for `roundId`.
 * Returns the sweep index (0-based) when each market first became settled.
 */
export async function runParallelLanesUntilMarketsSettled(
    engine: { read: { marketRoundStateByRound: (args: [bigint, number]) => Promise<unknown> } },
    scheduler: ParallelScheduler,
    roundId: bigint,
    marketIds: number[],
    opts?: ParallelRunOpts,
): Promise<Map<number, number>> {
    const laneCount = opts?.laneCount ?? DEFAULT_PAYOUT_LANE_COUNT;
    const maxIters = opts?.maxIters ?? 2000;
    const ordered = lanesInSweepOrder(laneCount, opts?.reverseSweep ?? false);
    const settledAt = new Map<number, number>();

    for (let sweep = 0; sweep < maxIters; sweep++) {
        for (const lane of ordered) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(lane)]);
            if (needed) {
                await scheduler.write.performUpkeep([performData]);
            }
        }
        for (const marketId of marketIds) {
            if (settledAt.has(marketId)) continue;
            const st = await engine.read.marketRoundStateByRound([roundId, marketId]);
            if (extractMarketSettled(st)) {
                settledAt.set(marketId, sweep);
            }
        }
        if (marketIds.every((m) => settledAt.has(m))) {
            return settledAt;
        }
    }
    throw new Error(`markets ${marketIds.join(",")} not settled within ${maxIters} sweeps (round ${roundId})`);
}

/** Runs lane sweeps until `currentGlobalRound()` reaches `targetRound` (e.g. after prior round fully completes). */
export async function runParallelLanesUntilGlobalRound(
    engine: { read: { currentGlobalRound: () => Promise<bigint> } },
    scheduler: ParallelScheduler,
    targetRound: bigint,
    opts?: ParallelRunOpts,
) {
    const laneCount = opts?.laneCount ?? DEFAULT_PAYOUT_LANE_COUNT;
    const maxIters = opts?.maxIters ?? 3000;
    const ordered = lanesInSweepOrder(laneCount, opts?.reverseSweep ?? false);

    for (let i = 0; i < maxIters; i++) {
        if ((await engine.read.currentGlobalRound()) >= targetRound) return;
        for (const lane of ordered) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(lane)]);
            if (needed) {
                await scheduler.write.performUpkeep([performData]);
            }
        }
    }
    const current = await engine.read.currentGlobalRound();
    throw new Error(`expected global round >= ${targetRound}, got ${current}`);
}

/** Runs lane sweeps until the engine has an outstanding VRF request (lane-0 pre-lock / trigger jobs). */
export async function runParallelLanesUntilVrfPending(
    engine: { read: { hasPendingVrf: () => Promise<boolean> } },
    scheduler: ParallelScheduler,
    opts?: ParallelRunOpts,
) {
    const laneCount = opts?.laneCount ?? DEFAULT_PAYOUT_LANE_COUNT;
    const maxIters = opts?.maxIters ?? 600;
    const ordered = lanesInSweepOrder(laneCount, opts?.reverseSweep ?? false);

    for (let i = 0; i < maxIters; i++) {
        if (await engine.read.hasPendingVrf()) return;
        for (const lane of ordered) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(lane)]);
            if (needed) {
                await scheduler.write.performUpkeep([performData]);
            }
        }
    }
    throw new Error(`VRF not requested within ${maxIters} lane sweeps`);
}

export async function fulfillVrfForGlobalRound(
    publicClient: {
        getContractEvents: (args: {
            address: `0x${string}`;
            abi: readonly unknown[];
            eventName: string;
            strict: boolean;
        }) => Promise<
            ReadonlyArray<{
                args: { newRoundId?: bigint; requestId?: bigint };
            }>
        >;
    },
    vrf: {
        write: {
            fulfill: (args: [`0x${string}`, bigint, bigint]) => Promise<unknown>;
            fulfillWithJackpot: (args: [`0x${string}`, bigint, bigint, bigint]) => Promise<unknown>;
        };
    },
    engine: { address: `0x${string}`; abi: readonly unknown[] },
    globalRoundId: bigint,
    winningNumber: bigint,
    opts?: { jackpotNumber?: bigint },
) {
    const events = await publicClient.getContractEvents({
        address: engine.address,
        abi: engine.abi,
        eventName: "VrfRequested",
        strict: true,
    });
    const hit = events.find((e) => e.args.newRoundId === globalRoundId);
    if (hit?.args.requestId === undefined) {
        throw new Error(`VrfRequested not found for global round ${globalRoundId}`);
    }
    const requestId = hit.args.requestId;
    if (opts?.jackpotNumber !== undefined) {
        await vrf.write.fulfillWithJackpot([engine.address, requestId, winningNumber, opts.jackpotNumber]);
    } else {
        await vrf.write.fulfill([engine.address, requestId, winningNumber]);
    }
}

/** Normalized jackpot stake weight (matches on-chain `RouletteEngine._jackpotStakeWeight`). */
export function jackpotStakeWeight(amount: bigint, decimals: number): bigint {
    const d = BigInt(decimals);
    if (d === 18n) return amount;
    if (d < 18n) return amount * 10n ** (18n - d);
    return amount / 10n ** (d - 18n);
}
