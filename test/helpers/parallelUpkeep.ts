import { encodeAbiParameters } from "viem";

export const DEFAULT_PAYOUT_LANE_COUNT = 10n;

export function laneCheckData(lane: bigint) {
    return lane === 0n ? ("0x" as const) : encodeAbiParameters([{ type: "uint256" }], [lane]);
}

/** Runs check/perform on every payout lane until no lane reports work. */
export async function runParallelLanesUntilIdle(
    scheduler: { read: { checkUpkeep: (args: [`0x${string}`]) => Promise<[boolean, `0x${string}`]> }; write: { performUpkeep: (args: [`0x${string}`]) => Promise<unknown> } },
    opts?: { laneCount?: bigint; maxIters?: number },
) {
    const laneCount = opts?.laneCount ?? DEFAULT_PAYOUT_LANE_COUNT;
    const maxIters = opts?.maxIters ?? 800;
    const lanes = Array.from({ length: Number(laneCount) }, (_, i) => BigInt(i));

    for (let i = 0; i < maxIters; i++) {
        let progressed = false;
        for (const lane of lanes) {
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

/** Normalized jackpot stake weight (matches on-chain `RouletteEngine._jackpotStakeWeight`). */
export function jackpotStakeWeight(amount: bigint, decimals: number): bigint {
    const d = BigInt(decimals);
    if (d === 18n) return amount;
    if (d < 18n) return amount * 10n ** (18n - d);
    return amount / 10n ** (d - 18n);
}
