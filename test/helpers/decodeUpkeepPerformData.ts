import { decodeAbiParameters } from "viem";

const ROULETTE_PERFORM_TYPES = [
    { type: "uint8" },
    { type: "uint256" },
    {
        type: "tuple",
        components: [
            { type: "uint8" },
            { type: "uint32" },
            { type: "uint64" },
            { type: "uint32" },
            { type: "uint32" },
            { type: "uint32" },
        ],
    },
    { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] },
    { type: "address[]" },
    { type: "uint256[]" },
] as const;

type JobTuple = readonly [number, number, bigint, number, number, number];

/** Decodes `UpkeepScheduler` roulette performData: `(UpkeepWorkKind, lane, job, …)`. */
export function decodeRoulettePerformData(performData: `0x${string}`) {
    const decoded = decodeAbiParameters(ROULETTE_PERFORM_TYPES, performData);
    const workKind = Number(decoded[0]);
    const lane = Number(decoded[1]);
    const job = decoded[2] as JobTuple;
    return {
        workKind,
        lane,
        jobKind: job[0],
        marketId: job[1],
        roundId: job[2],
        nextCursor: job[3],
        shardIndex: job[4],
        shardWidth: job[5],
    };
}
