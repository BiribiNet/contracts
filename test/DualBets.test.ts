import { expect } from "chai";
import { viem } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";
import { customErrorPattern } from "./helpers/customErrorPattern";
import { deployMaskFixture, lockAndFulfill, maskLeg, previewAllLanes, type MaskFixture } from "./helpers/maskBets";
import { encodeMultiBet, type BetLeg } from "./helpers/multiBetEncode";
import { laneCheckData, runParallelLanesUntilGlobalRound } from "./helpers/parallelUpkeep";

// Same canonical number, draw and odds used by the indexer and UI fixtures.
const cases = [
    [0n, 648, 0, 1, 2],
    [1n, 96, 0, 7, 27],
    [2n, 74, 0, 0, 26],
    [3n, 36, 0, 5, 32],
    [16665816212548n, 9, 0, 7, 29],
    [16664607920141n, 9, 204, 0, 0],
    [9286n, 2, 0, 17, 7],
    [7n, 1, 0, 0, 0],
] as const;

function dual(number: bigint, amount: bigint): BetLeg {
    return { betType: 17n, number, amount };
}

function place(s: MaskFixture, legs: BetLeg[], player = s.alice) {
    const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);
    return s.bank.write.placeBet([total, encodeMultiBet(legs), zeroAddress], { account: player.account });
}

describe("Deux billes", function () {
    this.timeout(300_000);

    it("matches the payout odds for all 1,369 ordered couples and all eight variants", async function () {
        const rules = await viem.deployContract("DualBetRulesHarness");
        for (const [raw, wins, refunds] of cases) {
            expect(await rules.read.tally([raw])).to.deep.equal([
                BigInt(wins), BigInt(refunds), BigInt(wins), BigInt(refunds),
            ]);
        }
    });

    it("pays every variant from the existing two-word draw, including the 0/0 jackpot trigger", async function () {
        const s = await deployMaskFixture({ laneCount: 3, maxPayoutsPerCall: 1 });
        await s.engine.write.setDualBetLimits([1, 20, 5000, 255]);
        const amount = s.unit + 1n;
        for (const [raw, wins, refunds, roulette, jackpot] of cases) {
            await place(s, [dual(raw, amount)]);
            const before = await s.token.read.balanceOf([s.alice.account.address]);
            const round = await lockAndFulfill(s, roulette, jackpot);
            expect((await s.engine.read.marketRoundStateByRound([round, 1])).winningBetCount).to.equal(1n);
            expect(await s.engine.read.roundJackpotTriggered([round])).to.deep.equal([true, roulette === jackpot]);
            const expected = amount * BigInt(1332 - refunds) / BigInt(wins);
            expect((await previewAllLanes(s, round, 1)).map(row => row.amount)).to.deep.equal([expected]);
            await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, round + 1n, { laneCount: 3n });
            expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(before + expected);
        }
    });

    it("settles mixed tickets and refunds exactly once across lanes after disabling placement", async function () {
        const s = await deployMaskFixture({ laneCount: 3, maxPayoutsPerCall: 1, maxLegs: 20 });
        const amount = s.unit;
        const refund = cases[5][0];
        // R=0 and J=26: the 0/26 wheel neighbors win and only R hits this refund mask.
        await s.engine.write.setDualBetLimits([1, 20, 5000, 255]);
        await place(s, [
            { betType: 1n, number: 0n, amount },
            maskLeg([0, 3], amount),
            dual(2n, amount),
            dual(refund, amount),
            dual(refund, amount),
            dual(refund, amount),
            dual(7n, amount),
        ]);
        await s.engine.write.setDualBetLimits([1, 0, 0, 0]);
        await expect(place(s, [dual(2n, amount)])).to.be.rejectedWith(customErrorPattern("DualBetDisabled()"));
        const before = await s.token.read.balanceOf([s.alice.account.address]);
        const round = await lockAndFulfill(s, 0, 26);
        const state = await s.engine.read.marketRoundStateByRound([round, 1]);
        expect(state.winningBetCount).to.equal(6n);
        const rows = await previewAllLanes(s, round, 1);
        expect(rows.map(row => [row.lane, row.amount / amount])).to.deep.equal([
            [0, 36n], [0, 1n], [1, 18n], [1, 1n], [2, 18n], [2, 1n],
        ]);
        await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, round + 1n, { laneCount: 3n });
        expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(before + 75n * amount);
        expect(await s.bank.read.lockedBetLiquidity()).to.equal(0n);
    });

    it("pays a Double zero and the principal jackpot to their respective players in the same round", async function () {
        const s = await deployMaskFixture({ laneCount: 3, maxPayoutsPerCall: 1 });
        await s.brb.write.transfer([s.treasury.address, 1000n * 10n ** 18n]);
        const pool = await s.treasury.read.jackpotPool();
        await s.engine.write.setDualBetLimits([1, 20, 5000, 1 << 7]);
        await place(s, [dual(7n, s.unit)]);
        await place(s, [{ betType: 1n, number: 0n, amount: s.unit }], s.bob);
        const [aliceAsset, aliceBrb, bobBrb] = await Promise.all([
            s.token.read.balanceOf([s.alice.account.address]),
            s.brb.read.balanceOf([s.alice.account.address]),
            s.brb.read.balanceOf([s.bob.account.address]),
        ]);
        const round = await lockAndFulfill(s, 0, 0);
        await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, round + 1n, { laneCount: 3n });
        expect((await s.engine.read.globalRoundState([round])).jackpotWinnerCount).to.equal(1);
        expect(await s.token.read.balanceOf([s.alice.account.address])).to.equal(aliceAsset + 1332n * s.unit);
        expect(await s.brb.read.balanceOf([s.alice.account.address])).to.equal(aliceBrb);
        expect(await s.brb.read.balanceOf([s.bob.account.address])).to.equal(bobBrb + pool);
    });

    it("validates encoding and enforces variant, leg, minimum stake and liability limits", async function () {
        const s = await deployMaskFixture();
        const amount = s.unit;
        expect(await s.engine.read.dualBetState([1])).to.deep.equal([0, 0, 0]);
        await expect(place(s, [dual(0n, amount)])).to.be.rejectedWith(customErrorPattern("DualBetDisabled()"));
        await s.engine.write.setDualBetLimits([1, 1, 1, 0b10000001]);
        for (const malformed of [1n << 51n, 8n, 6n | (1n << 3n), 6n | (1n << 3n) | (1n << 9n)]) {
            await expect(place(s, [dual(malformed, amount)])).to.be.rejectedWith(customErrorPattern("InvalidBetNumber()"));
        }
        await expect(place(s, [dual(1n, amount)])).to.be.rejectedWith(customErrorPattern("DualBetDisabled()"));
        await expect(place(s, [dual(7n, amount)])).to.be.rejectedWith(customErrorPattern("DualLiabilityCapExceeded()"));
        await expect(place(s, [
            { betType: 1n, number: 1n, amount }, dual(0n, amount - 1n),
        ])).to.be.rejectedWith(customErrorPattern("DualLegBelowMinBet()"));
        await place(s, [dual(0n, amount)]);
        await expect(place(s, [dual(0n, amount)])).to.be.rejectedWith(customErrorPattern("DualLegCapExceeded()"));
    });

    it("keeps the last mixed payout preview within the local keeper budget at combined capacity", async function () {
        const s = await deployMaskFixture({ laneCount: 10, maxPayoutsPerCall: 1, maxLegs: 512 });
        await s.engine.write.setDualBetLimits([1, 224, 10_000, 255]);
        const amount = s.unit;
        // 192 masks + 2 × 128 dual entries = 448 scan units. Only the final
        // 20 entries pay, forcing each of the ten lanes to scan the lost legs.
        const masks = Array.from({ length: 192 }, () => maskLeg([1, 2], amount));
        const duals = [
            ...Array.from({ length: 108 }, () => dual(cases[4][0], amount)),
            ...Array.from({ length: 20 }, (_, i) => dual(i % 2 === 0 ? 2n : cases[5][0], amount)),
        ];
        const legs = [...masks, ...duals];
        for (let i = 0; i < legs.length; i += 24) await place(s, legs.slice(i, i + 24));
        await expect(place(s, [maskLeg([1, 2], amount)]))
            .to.be.rejectedWith(customErrorPattern("DualRoundCapacityExceeded()"));
        await expect(place(s, [dual(2n, amount)]))
            .to.be.rejectedWith(customErrorPattern("DualRoundCapacityExceeded()"));
        const round = await lockAndFulfill(s, 0, 26);
        expect((await s.engine.read.marketRoundStateByRound([round, 1])).winningBetCount).to.equal(20n);
        const lane = laneCheckData(9n);
        const [first, payload] = await s.scheduler.read.checkUpkeep([lane]);
        expect(first).to.equal(true);
        await s.scheduler.write.performUpkeep([payload]);
        const [last] = await s.scheduler.read.checkUpkeep([lane]);
        expect(last).to.equal(true);
        const probe = await viem.deployContract("StaticCallGasProbe");
        const gas = await probe.read.measure([s.scheduler.address, encodeFunctionData({
            abi: s.scheduler.abi, functionName: "checkUpkeep", args: [lane],
        })]);
        console.log("DUAL_LAST_CHECK_UPKEEP_GAS", gas.toString());
        expect(gas).to.be.lessThan(1_500_000n);
    });
});
