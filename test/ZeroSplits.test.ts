import { viem } from "hardhat";

import { expect } from "chai";

describe("Roulette zero splits", function () {
    it("accepts only 0/1, 0/2 and 0/3 among IDs below 100, including explicit rejection of 0/4", async function () {
        const bets = await viem.deployContract("RouletteBetLib");
        for (let id = 0n; id < 100n; id++) {
            const valid = id >= 1n && id <= 3n;
            expect(await bets.read.isValidSplit([id]), `split ID ${id}`).to.equal(valid);
        }
    });

    it("preserves grid adjacency and rejects reversed or out-of-range encodings", async function () {
        const bets = await viem.deployContract("RouletteBetLib");
        for (let first = 1; first <= 36; first++) {
            for (let second = 0; second <= 36; second++) {
                const sameRow = Math.floor((first - 1) / 3) === Math.floor((second - 1) / 3);
                const valid = (sameRow && second === first + 1) || second === first + 3;
                // A vertical neighbour must still be on the 1–36 grid.
                expect(await bets.read.isValidSplit([BigInt(first * 100 + second)]), `${first}/${second}`)
                    .to.equal(valid);
            }
        }
        for (const id of [137n, 3738n, 3636n, (1n << 256n) - 1n]) {
            expect(await bets.read.isValidSplit([id]), `invalid ID ${id}`).to.equal(false);
        }
    });

    it("enumerates exactly the winning splits for every outcome from 0 to 36", async function () {
        const bets = await viem.deployContract("RouletteBetLib");
        // Build the legal pairs independently from the winner traversal.
        const pairs: [number, number][] = [[0, 1], [0, 2], [0, 3]];
        for (let row = 0; row < 12; row++) {
            for (let column = 0; column < 3; column++) {
                const number = row * 3 + column + 1;
                if (column < 2) pairs.push([number, number + 1]);
                if (row < 11) pairs.push([number, number + 3]);
            }
        }
        for (let outcome = 0; outcome <= 36; outcome++) {
            const expected = pairs.filter(([a, b]) => a === outcome || b === outcome)
                .map(([a, b]) => BigInt(a * 100 + b));
            const winning = await bets.read.getWinningBetTypes([BigInt(outcome)]);
            expect([...winning.winningSplits].sort(), `outcome ${outcome}`).to.deep.equal(expected.sort());
        }
    });
});
