import { encodeAbiParameters } from "viem";

export type BetLeg = { betType: bigint; number: bigint; amount: bigint };

export function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

export function encodeMultiBet(legs: readonly BetLeg[]) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [legs.map((l) => l.betType), legs.map((l) => l.number), legs.map((l) => l.amount)],
    );
}

/** Straight bets on numbers `0 .. count-1` (inclusive), each leg at `stakePerLeg`. */
export function straightLegs(count: number, stakePerLeg: bigint): BetLeg[] {
    const legs: BetLeg[] = [];
    for (let n = 0; n < count; n++) {
        legs.push({ betType: 1n, number: BigInt(n), amount: stakePerLeg });
    }
    return legs;
}

/** `count` distinct selections: straights on 0–36, then red/black/odd/even/low/high, dozens, columns, trio. */
export function distinctRouletteLegs(count: number, stakePerLeg: bigint): BetLeg[] {
    const legs: BetLeg[] = [];
    for (let n = 0; n < Math.min(count, 37); n++) {
        legs.push({ betType: 1n, number: BigInt(n), amount: stakePerLeg });
    }
    const flats: BetLeg[] = [
        { betType: 8n, number: 0n, amount: stakePerLeg },
        { betType: 9n, number: 0n, amount: stakePerLeg },
        { betType: 10n, number: 0n, amount: stakePerLeg },
        { betType: 11n, number: 0n, amount: stakePerLeg },
        { betType: 12n, number: 0n, amount: stakePerLeg },
        { betType: 13n, number: 0n, amount: stakePerLeg },
        { betType: 7n, number: 1n, amount: stakePerLeg },
        { betType: 7n, number: 2n, amount: stakePerLeg },
        { betType: 7n, number: 3n, amount: stakePerLeg },
        { betType: 6n, number: 1n, amount: stakePerLeg },
        { betType: 6n, number: 2n, amount: stakePerLeg },
        { betType: 6n, number: 3n, amount: stakePerLeg },
        { betType: 14n, number: 0n, amount: stakePerLeg },
    ];
    for (const leg of flats) {
        if (legs.length >= count) break;
        legs.push(leg);
    }
    if (legs.length !== count) {
        throw new Error(`distinctRouletteLegs: need ${count} legs, built ${legs.length}`);
    }
    return legs;
}
