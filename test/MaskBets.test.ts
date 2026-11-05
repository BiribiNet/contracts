import { viem } from "hardhat";

import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { decodeAbiParameters, zeroAddress, type Address } from "viem";

import { customErrorPattern } from "./helpers/customErrorPattern";
import {
    BET_MASK,
    FULL_BPS,
    LAUNCH_MAX_BPS,
    LAUNCH_MAX_LEGS,
    MASK_BITS,
    PRESET_SHIFT,
    deployMaskFixture,
    encodeMaskNumber,
    legPayout,
    lockAndFulfill,
    maskLeg,
    maskOf,
    maskPayout,
    multisetKey,
    popcount,
    previewAllLanes,
    settleRound,
    type MaskFixture,
    type RecordedLeg,
} from "./helpers/maskBets";
import { encodeMultiBet, type BetLeg } from "./helpers/multiBetEncode";

const BET_DATA_ABI = [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }] as const;

/** First `size` numbers of 1..36 then 0 — any distinct set works, the engine ignores semantics. */
function firstNumbers(size: number, offset = 0): number[] {
    return Array.from({ length: size }, (_, i) => (i + offset) % 37);
}

async function place(s: MaskFixture, legs: BetLeg[], who = s.alice, bank = s.bank) {
    const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);
    return bank.write.placeBet([total, encodeMultiBet(legs), zeroAddress], { account: who.account });
}

function rejectWith(signature: `${string}(${string})`) {
    return customErrorPattern(signature);
}

describe("Mask bets v1 — validation and encoding", function () {
    this.timeout(300_000);

    it("ships disabled: a fresh engine rejects every mask leg with MaskBetsDisabled", async function () {
        const s = await deployMaskFixture();
        expect(await s.engine.read.maskBetState([1n, 1])).to.deep.equal([0, 0, 0n, 0n]);
        await expect(place(s, [maskLeg([1, 2], s.unit)])).to.be.rejectedWith(rejectWith("MaskBetsDisabled()"));
        // Classic roulette is untouched while masks are off.
        await place(s, [{ betType: 1n, number: 7n, amount: s.unit }]);
    });

    it("accepts |S| = 2 and |S| = 24, rejects |S| ∈ {0, 1, 25, 37} with InvalidBetNumber", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await place(s, [maskLeg(firstNumbers(2), s.unit)]);
        await place(s, [maskLeg(firstNumbers(24), s.unit)]);
        for (const size of [0, 1, 25, 37]) {
            await expect(place(s, [maskLeg(firstNumbers(size), s.unit)]), `size ${size}`)
                .to.be.rejectedWith(rejectWith("InvalidBetNumber()"));
        }
        expect((await s.engine.read.maskBetState([1n, 1]))[2]).to.equal(2n);
    });

    it("bit 37 alone is an empty mask, presetId = 511 is accepted, any bit ≥ 53 reverts", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        const bet = (numberRaw: bigint) => place(s, [{ betType: BET_MASK, number: numberRaw, amount: s.unit }]);
        await expect(bet(1n << 37n)).to.be.rejectedWith(rejectWith("InvalidBetNumber()"));
        await bet(encodeMaskNumber(maskOf([3, 4]), { presetId: 511n }));
        // Largest valid encoding: full presetId, guard bit clear ⇒ expectedPrev must be 0.
        await bet(maskOf([5, 6]) | (511n << PRESET_SHIFT));
        for (const bit of [53n, 60n, 128n, 255n]) {
            await expect(bet(maskOf([1, 2]) | (1n << bit)), `bit ${bit}`).to.be.rejectedWith(rejectWith("InvalidBetNumber()"));
        }
    });

    it("rejects a zero-stake mask leg (ZeroBetAmount) and bet types above 16 (InvalidBetType)", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await expect(place(s, [{ betType: 1n, number: 7n, amount: s.unit }, maskLeg([1, 2], 0n)]))
            .to.be.rejectedWith(rejectWith("ZeroBetAmount()"));
        await expect(place(s, [{ betType: 17n, number: maskOf([1, 2]), amount: s.unit }]))
            .to.be.rejectedWith(rejectWith("InvalidBetType()"));
    });

    it("enforces minBet per mask leg even when the transaction total is above minBet", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        // Classic dust legs keep their historical per-transaction minBet rule.
        await place(s, [{ betType: 1n, number: 7n, amount: s.unit }, { betType: 1n, number: 8n, amount: 1n }]);
        await expect(place(s, [maskLeg([1, 2], 10n * s.unit), maskLeg([3, 4], s.unit - 1n)]))
            .to.be.rejectedWith(rejectWith("MaskLegBelowMinBet()"));
        await expect(place(s, [{ betType: 1n, number: 7n, amount: 10n * s.unit }, maskLeg([3, 4], 1n)]))
            .to.be.rejectedWith(rejectWith("MaskLegBelowMinBet()"));
        await place(s, [maskLeg([1, 2], s.unit), maskLeg([3, 4], s.unit)]);
    });

    it("presetId has no effect on counters, liability or payout, and travels in BetRecorded/BetPlaced", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        const numbers = [4, 9, 16, 25];
        await place(s, [maskLeg(numbers, 7n * s.unit, { presetId: 0n })], s.alice);
        const [, , , afterFirst] = await s.engine.read.maskBetState([1n, 1]);
        await place(s, [maskLeg(numbers, 7n * s.unit, { presetId: 300n })], s.bob);
        const [, , legs, afterSecond] = await s.engine.read.maskBetState([1n, 1]);
        expect(legs).to.equal(2n);
        expect(afterSecond).to.equal(afterFirst * 2n);

        const recorded = await s.publicClient.getContractEvents({ address: s.engine.address, abi: s.engine.abi, eventName: "BetRecorded", fromBlock: 0n });
        const placed = await s.publicClient.getContractEvents({ address: s.bank.address, abi: s.bank.abi, eventName: "BetPlaced", fromBlock: 0n });
        for (const [index, presetId] of [[0, 0n], [1, 300n]] as const) {
            const [types, nums] = decodeAbiParameters(BET_DATA_ABI, recorded[index].args.betData!);
            expect(types[0]).to.equal(BET_MASK);
            expect((nums[0] >> PRESET_SHIFT) & 511n).to.equal(presetId);
            expect(nums[0] & MASK_BITS).to.equal(maskOf(numbers));
            expect(nums[0] < 2n ** 53n).to.equal(true);
            const [, placedNums] = decodeAbiParameters(BET_DATA_ABI, placed[index].args.data!);
            expect(placedNums[0]).to.equal(nums[0]);
        }

        await lockAndFulfill(s, 16);
        expect((await s.engine.read.marketRoundStateByRound([1n, 1])).winningBetCount).to.equal(2n);
        const rows = await previewAllLanes(s, 1n, 1);
        expect(rows.map((row) => row.amount)).to.deep.equal([63n * s.unit, 63n * s.unit]);
        expect(new Set(rows.map((row) => row.player.toLowerCase()))).to.deep.equal(
            new Set([s.alice.account.address.toLowerCase(), s.bob.account.address.toLowerCase()]),
        );
    });
});

describe("Mask bets v1 — payout formula", function () {
    this.timeout(600_000);

    for (const decimals of [6, 18] as const) {
        it(`pays floor(amount × 36 / |S|) for every |S| in [2, 24] (${decimals} decimals)`, async function () {
            const s = await deployMaskFixture({ decimals, maxLegs: LAUNCH_MAX_LEGS, liquidityUnits: 5_000_000n });
            const amounts = [s.unit, s.unit + 1n, 10n ** BigInt(decimals), 1_000_003n * (s.unit / 1000n) + 7n, 97n * s.unit + 13n];
            const winning = 0;
            const legs: BetLeg[] = [];
            const expected: { player: Address; amount: bigint }[] = [];
            let weighted = 0n;
            for (let size = 2; size <= 24; size++) {
                for (const amount of amounts) {
                    legs.push(maskLeg(firstNumbers(size), amount));
                    expected.push({ player: s.alice.account.address, amount: maskPayout(amount, size) });
                    weighted += maskPayout(amount, size);
                    // |S| × payout ≤ amount × 36: the house edge never goes below 1/37.
                    expect(BigInt(size) * maskPayout(amount, size) <= amount * 36n).to.equal(true);
                }
            }
            for (let i = 0; i < legs.length; i += 40) await place(s, legs.slice(i, i + 40));
            expect((await s.engine.read.maskBetState([1n, 1]))[3]).to.equal(weighted);

            const before = await s.token.read.balanceOf([s.alice.account.address]);
            await lockAndFulfill(s, winning);
            const rows = await previewAllLanes(s, 1n, 1);
            expect(multisetKey(rows)).to.deep.equal(multisetKey(expected));
            await settleRemaining(s);
            const paid = expected.reduce((sum, row) => sum + row.amount, 0n);
            expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(before + paid);
        });
    }

    it("matches the published multiplier table (1 USDC on 11 numbers pays 3 272 727)", function () {
        expect(maskPayout(1_000_000n, 11)).to.equal(3_272_727n);
        const table: Record<number, bigint> = { 2: 18n, 3: 12n, 4: 9n, 6: 6n, 9: 4n, 12: 3n, 18: 2n };
        for (const [size, multiplier] of Object.entries(table)) {
            expect(maskPayout(1_000_000n, Number(size))).to.equal(1_000_000n * multiplier);
        }
    });
});

async function settleRemaining(s: MaskFixture) {
    const { runParallelLanesUntilGlobalRound } = await import("./helpers/parallelUpkeep");
    const roundId = await s.engine.read.currentGlobalRound();
    const laneCount = BigInt(await s.engine.read.payoutParallelLaneCount());
    await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, roundId + 1n, { laneCount });
}

describe("Mask bets v1 — previous-outcome guard", function () {
    this.timeout(600_000);

    it("round 1 has no previous outcome: a guarded leg reverts PreviousOutcomeMismatch", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await expect(place(s, [maskLeg([1, 2], s.unit, { guard: true, expectedPrev: 0n })]))
            .to.be.rejectedWith(rejectWith("PreviousOutcomeMismatch()"));
    });

    it("accepts the real previous number, rejects any other, and validates the guard bits", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await place(s, [{ betType: 1n, number: 1n, amount: s.unit }]);
        await settleRound(s, 17);
        expect(await s.engine.read.currentGlobalRound()).to.equal(2n);

        await place(s, [maskLeg([18, 19, 20], s.unit, { guard: true, expectedPrev: 17n })]);
        await expect(place(s, [maskLeg([18, 19, 20], s.unit, { guard: true, expectedPrev: 18n })]))
            .to.be.rejectedWith(rejectWith("PreviousOutcomeMismatch()"));
        await expect(place(s, [maskLeg([18, 19, 20], s.unit, { guard: false, expectedPrev: 17n })]))
            .to.be.rejectedWith(rejectWith("InvalidBetNumber()"));
        for (const prev of [37n, 50n, 63n]) {
            await expect(place(s, [maskLeg([18, 19], s.unit, { guard: true, expectedPrev: prev })]), `prev ${prev}`)
                .to.be.rejectedWith(rejectWith("PreviousOutcomeMismatch()"));
        }
        // One wrong guarded leg among correct ones fails the whole transaction.
        await expect(place(s, [
            maskLeg([18, 19], s.unit, { guard: true, expectedPrev: 17n }),
            maskLeg([20, 21], s.unit, { guard: true, expectedPrev: 16n }),
        ])).to.be.rejectedWith(rejectWith("PreviousOutcomeMismatch()"));
    });

    it("reads the previous outcome once per transaction for every guarded leg (gas)", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await place(s, [{ betType: 1n, number: 1n, amount: s.unit }]);
        await settleRound(s, 17);
        // Warm the round's mask storage so every estimate below starts from the same state.
        await place(s, [maskLeg([30, 31], s.unit), maskLeg([32, 33], s.unit)], s.bob);
        // Each measurement runs from the same chain state (snapshot/restore) and uses the receipt's gasUsed.
        const estimate = async (legs: BetLeg[]) => {
            const snapshot = await takeSnapshot();
            const hash = await place(s, legs);
            const { gasUsed } = await s.publicClient.waitForTransactionReceipt({ hash });
            await snapshot.restore();
            return gasUsed;
        };
        const guard = { guard: true, expectedPrev: 17n };
        const oneFree = await estimate([maskLeg([1, 2], s.unit)]);
        const twoFree = await estimate([maskLeg([1, 2], s.unit), maskLeg([3, 4], s.unit)]);
        const oneGuarded = await estimate([maskLeg([1, 2], s.unit, guard)]);
        const twoGuarded = await estimate([maskLeg([1, 2], s.unit, guard), maskLeg([3, 4], s.unit, guard)]);
        const firstGuardCost = oneGuarded - oneFree;
        const secondGuardCost = (twoGuarded - oneGuarded) - (twoFree - oneFree);
        console.log("MASK_GUARD_GAS", JSON.stringify({ oneFree, twoFree, oneGuarded, twoGuarded, firstGuardCost, secondGuardCost },
            (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        // The first guarded leg pays the cold reads of the previous outcome (two slots of the existing struct)…
        expect(firstGuardCost > 4_000n).to.equal(true);
        // …every further guarded leg only pays calldata for the extra non-zero bytes.
        expect(secondGuardCost < 600n).to.equal(true);
    });

    it("a leg prepared in r and mined in r+1 reverts if the previous number changed, passes if it repeated", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await place(s, [{ betType: 1n, number: 1n, amount: s.unit }]);
        await settleRound(s, 17); // round 1 → 17
        const prepared = [maskLeg([20, 21, 22], s.unit, { guard: true, expectedPrev: 17n })];
        await place(s, prepared);
        await settleRound(s, 17); // round 2 → 17 again
        // Same previous number: the guard only compares numbers, not round ids (spec §7).
        await place(s, prepared);
        await settleRound(s, 20); // round 3 → 20
        await expect(place(s, prepared)).to.be.rejectedWith(rejectWith("PreviousOutcomeMismatch()"));
        await place(s, [maskLeg([20, 21, 22], s.unit, { guard: true, expectedPrev: 20n })]);
    });
});

describe("Mask bets v1 — per-market limits", function () {
    this.timeout(300_000);

    it("accepts exactly N legs, rejects N+1 (MaskLegCapExceeded), and 0 disables (MaskBetsDisabled)", async function () {
        const s = await deployMaskFixture({ maxLegs: 3 });
        await place(s, [maskLeg([1, 2], s.unit), maskLeg([3, 4], s.unit)]);
        await place(s, [maskLeg([5, 6], s.unit)], s.bob);
        await expect(place(s, [maskLeg([7, 8], s.unit)], s.carol)).to.be.rejectedWith(rejectWith("MaskLegCapExceeded()"));
        // A batch that would cross the cap is rejected atomically.
        await s.engine.write.setMaskBetLimits([1, 4, FULL_BPS]);
        await expect(place(s, [maskLeg([7, 8], s.unit), maskLeg([9, 10], s.unit)])).to.be.rejectedWith(rejectWith("MaskLegCapExceeded()"));
        await place(s, [maskLeg([7, 8], s.unit)]);
        await s.engine.write.setMaskBetLimits([1, 0, FULL_BPS]);
        await expect(place(s, [maskLeg([9, 10], s.unit)])).to.be.rejectedWith(rejectWith("MaskBetsDisabled()"));
        // Emergency switch: classic bets still land and the recorded masks still settle.
        await place(s, [{ betType: 1n, number: 2n, amount: s.unit }]);
        const before = await s.token.read.balanceOf([s.alice.account.address]);
        await settleRound(s, 1);
        expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(before + 18n * s.unit);
    });

    it("setter: role-gated, emits MaskBetLimitsUpdated, validates bounds and the market id", async function () {
        const s = await deployMaskFixture({ markets: 2 });
        await expect(s.engine.write.setMaskBetLimits([1, LAUNCH_MAX_LEGS, LAUNCH_MAX_BPS], { account: s.stranger.account }))
            .to.be.rejectedWith(/AccessControlUnauthorizedAccount/);
        const hash = await s.engine.write.setMaskBetLimits([2, LAUNCH_MAX_LEGS, LAUNCH_MAX_BPS]);
        const receipt = await s.publicClient.waitForTransactionReceipt({ hash });
        const events = await s.publicClient.getContractEvents({
            address: s.engine.address, abi: s.engine.abi, eventName: "MaskBetLimitsUpdated", blockHash: receipt.blockHash,
        });
        expect(events.map((event) => event.args)).to.deep.equal([{ marketId: 2, maxLegsPerRound: LAUNCH_MAX_LEGS, maxLiabilityBps: LAUNCH_MAX_BPS }]);
        expect(await s.engine.read.maskBetState([1n, 2])).to.deep.equal([LAUNCH_MAX_LEGS, LAUNCH_MAX_BPS, 0n, 0n]);
        expect(await s.engine.read.maskBetState([1n, 1])).to.deep.equal([0, 0, 0n, 0n]);
        await expect(s.engine.write.setMaskBetLimits([1, 65_536, LAUNCH_MAX_BPS])).to.be.rejectedWith(rejectWith("InvalidMaskBetLimits()"));
        await expect(s.engine.write.setMaskBetLimits([1, 10, 10_001])).to.be.rejectedWith(rejectWith("InvalidMaskBetLimits()"));
        await expect(s.engine.write.setMaskBetLimits([3, 10, 100])).to.be.rejectedWith(/InvalidMarketId|0x[0-9a-f]{8}/);
        await s.engine.write.setMaskBetLimits([1, 65_535, 10_000]);
    });

    it("isolates markets: a market at 0 does not affect another, caps are counted per market", async function () {
        const s = await deployMaskFixture({ markets: 2 });
        const [m1, m2] = s.markets;
        await s.engine.write.setMaskBetLimits([1, 1, FULL_BPS]);
        await place(s, [maskLeg([1, 2], s.unit)], s.alice, m1.bank);
        await expect(place(s, [maskLeg([1, 2], s.unit)], s.alice, m2.bank)).to.be.rejectedWith(rejectWith("MaskBetsDisabled()"));
        await s.engine.write.setMaskBetLimits([2, 1, FULL_BPS]);
        await place(s, [maskLeg([1, 2], s.unit)], s.bob, m2.bank);
        await expect(place(s, [maskLeg([3, 4], s.unit)], s.bob, m1.bank)).to.be.rejectedWith(rejectWith("MaskLegCapExceeded()"));
        await s.engine.write.setMaskBetLimits([1, 0, FULL_BPS]);
        await expect(place(s, [maskLeg([3, 4], s.unit)], s.carol, m1.bank)).to.be.rejectedWith(rejectWith("MaskBetsDisabled()"));
        expect((await s.engine.read.maskBetState([1n, 2]))[2]).to.equal(1n);
    });

    it("liability cap: summed mask payouts ≤ maxMaskLiabilityBps of free liquidity, classic bets never blocked", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS, maxBps: LAUNCH_MAX_BPS, liquidityUnits: 10_000n });
        // Free liquidity after the bet = 10 000 units + stake. 10 % cap ≈ 1 000 units of summed payouts.
        const nav = await s.bank.read.totalAssets();
        // Largest |S| = 2 stake whose 18× payout fits: 18a ≤ (nav + a) / 10 ⇔ a ≤ nav / 179.
        const fit = nav / 179n;
        await place(s, [maskLeg([1, 2], fit)]);
        await expect(place(s, [maskLeg([3, 4], s.unit)])).to.be.rejectedWith(rejectWith("MaskLiabilityCapExceeded()"));
        // A classic bet is not checked against the mask cap, even after the cap is lowered.
        await s.engine.write.setMaskBetLimits([1, LAUNCH_MAX_LEGS, 1]);
        await place(s, [{ betType: 8n, number: 0n, amount: 10n * s.unit }], s.bob);
        await s.engine.write.setMaskBetLimits([1, LAUNCH_MAX_LEGS, FULL_BPS]);
        await place(s, [maskLeg([3, 4], s.unit)]);
    });

    it("solvency: masks beyond the buffered liability revert InsufficientBankForMaxPayout", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS, liquidityUnits: 1_000n });
        // 1.1 × 18a > nav + a for a = nav / 18.
        const nav = await s.bank.read.totalAssets();
        await expect(place(s, [maskLeg([1, 2], nav / 18n)])).to.be.rejectedWith(rejectWith("InsufficientBankForMaxPayout()"));
        await place(s, [maskLeg([1, 2], nav / 19n - s.unit)]);
    });
});

describe("Mask bets v1 — jackpot", function () {
    this.timeout(300_000);

    async function jackpotFixture() {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        await s.brb.write.transfer([s.treasury.address, 1000n * 10n ** 18n]);
        return s;
    }

    it("a mask covering the jackpot number never wins the jackpot", async function () {
        const s = await jackpotFixture();
        const pool = await s.treasury.read.jackpotPool();
        await place(s, [maskLeg([7, 8], 10n * s.unit)], s.alice);
        await place(s, [maskLeg(firstNumbers(24), 10n * s.unit)], s.bob);
        const aliceBrb = await s.brb.read.balanceOf([s.alice.account.address]);
        await settleRound(s, 7, 7);
        const gr = await s.engine.read.globalRoundState([1n]);
        expect(gr.jackpotTriggered).to.equal(true);
        expect(gr.jackpotDistributed).to.equal(true);
        expect(gr.jackpotPaid).to.equal(0n);
        expect(await s.treasury.read.jackpotPool()).to.be.gte(pool);
        expect(await s.brb.read.balanceOf([s.alice.account.address])).to.equal(aliceBrb);
        expect(await s.engine.read.currentGlobalRound()).to.equal(2n);
    });

    it("straight + mask on the jackpot number: only the straight is eligible", async function () {
        const s = await jackpotFixture();
        const pool = await s.treasury.read.jackpotPool();
        await place(s, [{ betType: 1n, number: 7n, amount: s.unit }], s.alice);
        await place(s, [maskLeg([7, 8], 50n * s.unit)], s.bob);
        const bobBrb = await s.brb.read.balanceOf([s.bob.account.address]);
        const aliceBrb = await s.brb.read.balanceOf([s.alice.account.address]);
        await settleRound(s, 7, 7);
        expect(await s.brb.read.balanceOf([s.bob.account.address])).to.equal(bobBrb);
        expect(await s.brb.read.balanceOf([s.alice.account.address])).to.equal(aliceBrb + pool);
        expect((await s.engine.read.globalRoundState([1n])).jackpotWinnerCount).to.equal(1);
    });
});

/** Mixed classic + overlapping masks from three players, deterministic. */
function mixedLegs(s: MaskFixture): RecordedLeg[] {
    const u = s.unit;
    const a = s.alice.account.address, b = s.bob.account.address, c = s.carol.account.address;
    const legs: RecordedLeg[] = [];
    const push = (player: Address, leg: BetLeg) => legs.push({ player, ...leg });
    for (let n = 0; n < 37; n += 3) push(a, { betType: 1n, number: BigInt(n), amount: u + BigInt(n) });
    push(b, { betType: 8n, number: 0n, amount: 5n * u });
    push(c, { betType: 9n, number: 0n, amount: 3n * u });
    push(a, { betType: 7n, number: 2n, amount: 2n * u });
    push(b, { betType: 6n, number: 1n, amount: 2n * u + 1n });
    // Overlapping masks: same numbers in several masks, same and different players, all sizes.
    for (let i = 0; i < 37; i++) {
        const size = 2 + (i % 23);
        const numbers = Array.from({ length: size }, (_, k) => (i * 5 + k * 7) % 37);
        const player = [a, b, c][i % 3];
        push(player, maskLeg(numbers, u + BigInt(i) * 1_003n));
        if (i % 4 === 0) push(player, maskLeg(numbers, 2n * u + 17n));
    }
    push(c, maskLeg([0, 36], 4n * u));
    push(a, maskLeg([0, 36], 4n * u));
    return legs;
}

async function placeRecorded(s: MaskFixture, legs: RecordedLeg[]) {
    const byPlayer = new Map<string, RecordedLeg[]>();
    for (const leg of legs) {
        const key = leg.player.toLowerCase();
        byPlayer.set(key, [...(byPlayer.get(key) ?? []), leg]);
    }
    for (const wallet of [s.alice, s.bob, s.carol]) {
        const mine = byPlayer.get(wallet.account.address.toLowerCase()) ?? [];
        for (let i = 0; i < mine.length; i += 20) await place(s, mine.slice(i, i + 20), wallet);
    }
}

function expectedRows(legs: RecordedLeg[], winning: number) {
    return legs.flatMap((leg) => {
        const amount = legPayout(leg, winning);
        return amount === 0n ? [] : [{ player: leg.player, amount }];
    });
}

describe("Mask bets v1 — settlement concordance", function () {
    this.timeout(1_800_000);

    for (const laneCount of [1, 10]) {
        it(`counters and sweep agree for all 37 numbers (${laneCount} lane${laneCount > 1 ? "s" : ""})`, async function () {
            const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS, laneCount, liquidityUnits: 1_000_000n });
            const legs = mixedLegs(s);
            await placeRecorded(s, legs);
            for (let winning = 0; winning < 37; winning++) {
                const snapshot = await takeSnapshot();
                await lockAndFulfill(s, winning);
                const expected = expectedRows(legs, winning);
                const mr = await s.engine.read.marketRoundStateByRound([1n, 1]);
                expect(mr.winningBetCount, `winning count ${winning}`).to.equal(BigInt(expected.length));
                const rows = await previewAllLanes(s, 1n, 1);
                expect(multisetKey(rows), `rows ${winning}`).to.deep.equal(multisetKey(expected));
                const maskWinners = legs.filter((leg) => leg.betType === BET_MASK && legPayout(leg, winning) > 0n).length;
                expect(maskWinners).to.be.greaterThan(0);
                await snapshot.restore();
            }
        });
    }

    for (const [laneCount, winning] of [[1, 0], [10, 17], [10, 36], [3, 5]] as const) {
        it(`pays overlapping masks + classic bets to the wei with small chunks (lanes ${laneCount}, number ${winning})`, async function () {
            const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS, laneCount, maxPayoutsPerCall: 2, liquidityUnits: 1_000_000n });
            const legs = mixedLegs(s);
            const players = [s.alice, s.bob, s.carol];
            const before = await Promise.all(players.map((p) => s.token.read.balanceOf([p.account.address])));
            await placeRecorded(s, legs);
            await settleRound(s, winning);
            for (const [index, player] of players.entries()) {
                const mine = legs.filter((leg) => leg.player.toLowerCase() === player.account.address.toLowerCase());
                const staked = mine.reduce((sum, leg) => sum + leg.amount, 0n);
                const won = mine.reduce((sum, leg) => sum + legPayout(leg, winning), 0n);
                expect(await s.token.read.balanceOf([player.account.address])).to.equal(before[index] - staked + won);
            }
            expect(await s.bank.read.lockedBetLiquidity()).to.equal(0n);
            expect((await s.engine.read.marketRoundStateByRound([1n, 1])).settled).to.equal(true);
        });
    }
});

describe("Mask bets v1 — gas (local Hardhat, 6 decimals, stake = minBet)", function () {
    this.timeout(300_000);

    it("measures a mask bet against the classic reference transactions", async function () {
        const s = await deployMaskFixture({ maxLegs: LAUNCH_MAX_LEGS });
        const gasOf = async (legs: BetLeg[], who = s.alice) =>
            (await s.publicClient.waitForTransactionReceipt({ hash: await place(s, legs, who) })).gasUsed;
        const firstBetOfRound = await gasOf([{ betType: 1n, number: 7n, amount: s.unit }], s.carol);
        const firstMask = await gasOf([maskLeg([1, 2], s.unit)]);
        const nextMaskTwoNumbers = await gasOf([maskLeg([3, 4], s.unit)], s.bob);
        const nextMaskTwentyFourNumbers = await gasOf([maskLeg(firstNumbers(24, 5), s.unit)], s.bob);
        const nextSplit = await gasOf([{ betType: 2n, number: 1n, amount: s.unit }], s.bob);
        const tenMasks = await gasOf(Array.from({ length: 10 }, (_, i) => maskLeg([i, i + 20], s.unit)), s.bob);
        const oneMaskForTen = await gasOf([maskLeg([30, 31], s.unit)], s.bob);
        const measurements = {
            firstBetOfRound, firstMask, nextMaskTwoNumbers, nextMaskTwentyFourNumbers, nextSplit, tenMasks,
            marginalMaskLeg: (tenMasks - oneMaskForTen) / 9n,
        };
        console.log("MASK_BET_GAS", JSON.stringify(measurements, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        // Spec §3.3 estimate for option (a): ≈ 80 000 – 145 000 gas per marginal mask leg.
        expect(measurements.marginalMaskLeg < 145_000n).to.equal(true);
    });
});
