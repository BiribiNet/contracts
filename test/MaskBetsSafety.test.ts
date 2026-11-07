import { artifacts, viem } from "hardhat";

import { expect } from "chai";
import { maxUint256, parseUnits, toFunctionSelector, toHex, zeroAddress, type Address } from "viem";

import { customErrorPattern } from "./helpers/customErrorPattern";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import {
    BET_MASK,
    FULL_BPS,
    LAUNCH_MAX_LEGS,
    deployMaskFixture,
    legPayout,
    maskLeg,
    maskPayout,
    popcount,
    prng,
    settleRound,
    type MaskFixture,
    type RecordedLeg,
} from "./helpers/maskBets";
import { encodeMultiBet, encodeSingleBet, type BetLeg } from "./helpers/multiBetEncode";
import { runParallelLanesUntilIdle } from "./helpers/parallelUpkeep";

const BANK_VAULT_STORAGE_LOCATION = 0xb0c430920bd46af8c5ecb68ebf1a5f6f3805a863a6d4fa0fa5e65feb72f8e800n;

async function place(s: MaskFixture, legs: BetLeg[], who = s.alice) {
    const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);
    return s.bank.write.placeBet([total, encodeMultiBet(legs), zeroAddress], { account: who.account });
}

/** Buffered liability of the open round = shortfall + stakes (valid whenever liability > stakes). */
async function bufferedLiability(s: MaskFixture, roundId: bigint) {
    const need = await s.engine.read.marketRouletteLiquidityNeed([1]);
    const stakes = (await s.engine.read.marketRoundStateByRound([roundId, 1])).totals.totalAmount;
    return need + stakes;
}

describe("Mask bets v1 — NAV invariant (adapted replay of the 2026-11-04 incident)", function () {
    this.timeout(300_000);

    for (const decimals of [6, 18] as const) {
        it(`five 18× masks at the solvency limit leave totalAssets() unchanged; the next deposit mints at par (${decimals} decimals)`, async function () {
            const s = await deployMaskFixture({ decimals, maxLegs: LAUNCH_MAX_LEGS, maxBps: FULL_BPS, liquidityUnits: 100n });
            const nav = await s.bank.read.totalAssets();
            const deposit = s.unit + 1n;
            const quote = await s.bank.read.previewDeposit([deposit]);
            const supply = await s.bank.read.totalSupply();
            // 1.1 × 18 × 5a ≤ nav + 5a ⇔ a ≤ nav / 94: the largest stake solvency accepts five times.
            const stake = nav / 94n;
            expect(stake >= s.unit).to.equal(true);
            for (let i = 0; i < 5; i++) {
                await place(s, [maskLeg([2 * i + 1, 2 * i + 2], stake)], s.bob);
                expect(await s.bank.read.totalAssets(), `after mask ${i + 1}`).to.equal(nav);
                expect(await s.bank.read.previewDeposit([deposit])).to.equal(quote);
            }
            await expect(place(s, [maskLeg([20, 21], stake)], s.bob))
                .to.be.rejectedWith(customErrorPattern("InsufficientBankForMaxPayout()"));
            // Only the stakes are locked — never a payout reserve.
            expect(await s.bank.read.lockedBetLiquidity()).to.equal(5n * stake);

            const before = await s.bank.read.balanceOf([s.carol.account.address]);
            await s.bank.write.deposit([deposit, s.carol.account.address], { account: s.carol.account });
            const minted = (await s.bank.read.balanceOf([s.carol.account.address])) - before;
            expect(minted).to.equal(quote);
            // The depositor owns ≈ deposit / (nav + deposit) of the vault — nothing like the incident's ~100 %.
            expect(minted * 100n < (supply + minted) * 2n).to.equal(true);
        });
    }
});

describe("Mask bets v1 — drainWithdrawalQueue while a mask is open", function () {
    this.timeout(300_000);

    for (const decimals of [6, 18] as const) {
        it(`is blocked by an open mask's liquidity need, then usable after settlement (${decimals} decimals)`, async function () {
            const s = await deployMaskFixture({ decimals, maxLegs: LAUNCH_MAX_LEGS, liquidityUnits: 1_000n });
            await s.bank.write.deposit([100n * s.unit, s.alice.account.address], { account: s.alice.account });
            await place(s, [maskLeg([1, 2], 10n * s.unit)], s.bob);
            expect(await s.engine.read.marketRouletteLiquidityNeed([1])).to.be.gt(0n);
            await s.bank.write.redeemBps([10_000, s.alice.account.address, s.alice.account.address], { account: s.alice.account });
            await expect(s.bank.write.drainWithdrawalQueue([10n], { account: s.stranger.account }))
                .to.be.rejectedWith(customErrorPattern("WithdrawalBlockedDuringResolution()"));
            await settleRound(s, 1);
            expect(await s.engine.read.marketRouletteLiquidityNeed([1])).to.equal(0n);
            // Settlement served Alice's request; a fresh request can now use the public hatch.
            expect(await s.bank.read.balanceOf([s.alice.account.address])).to.equal(0n);
            await s.bank.write.redeemBps([1_000, s.admin.account.address, s.admin.account.address]);
            await s.bank.write.drainWithdrawalQueue([10n], { account: s.stranger.account });
            expect((await s.bank.read.pendingWithdrawalStatus([s.admin.account.address]))[1]).to.equal(false);
        });

        it(`reverts the atomic mask bet → withdrawal request → public drain sequence (${decimals} decimals)`, async function () {
            const s = await deployMaskFixture({ decimals, maxLegs: LAUNCH_MAX_LEGS, liquidityUnits: 1_000n });
            const attempt = await viem.deployContract("RouletteDrainAttempt");
            await s.token.write.approve([attempt.address, maxUint256], { account: s.alice.account });
            await attempt.write.deposit([s.token.address, s.bank.address, 100n * s.unit], { account: s.alice.account });
            const shares = await s.bank.read.balanceOf([attempt.address]);
            const nav = await s.bank.read.totalAssets();
            const gross = await s.token.read.balanceOf([s.bank.address]);
            const stake = 10n * s.unit;
            await expect(attempt.write.betThenDrain([s.token.address, s.bank.address, stake,
                encodeMultiBet([maskLeg([7, 8, 9], stake)])], { account: s.alice.account }))
                .to.be.rejectedWith(customErrorPattern("WithdrawalBlockedDuringResolution()"));
            expect(await s.bank.read.balanceOf([attempt.address])).to.equal(shares);
            expect(await s.bank.read.totalAssets()).to.equal(nav);
            expect(await s.token.read.balanceOf([s.bank.address])).to.equal(gross);
            expect(await s.bank.read.lockedBetLiquidity()).to.equal(0n);
            expect((await s.engine.read.maskBetState([1n, 1]))[2]).to.equal(0n);
        });
    }
});

describe("Mask bets v1 — vault without the side-bet surface", function () {
    this.timeout(300_000);

    it("ABI drops lockSideBetStake / setSideBetController / sideBetController, keeps availableForSideBet and initialize", async function () {
        const current = await artifacts.readArtifact("BankVault4626");
        const legacy = await artifacts.readArtifact("LegacySideBetBankVault4626");
        const names = (abi: readonly { type: string; name?: string }[], type: string) =>
            abi.filter((entry) => entry.type === type).map((entry) => entry.name);
        const functions = names(current.abi, "function");
        for (const gone of ["lockSideBetStake", "setSideBetController", "sideBetController"]) {
            expect(functions, gone).not.to.include(gone);
        }
        expect(functions).to.include("availableForSideBet");
        expect(names(current.abi, "event")).not.to.include.members(["SideBetStakeLocked"]);
        expect(names(current.abi, "event")).not.to.include("SideBetControllerUpdated");
        for (const gone of ["OnlySideBet", "InsufficientSideBetLiquidity", "UnauthorizedSettlementCaller"]) {
            expect(names(current.abi, "error"), gone).not.to.include(gone);
        }
        // `MarketRegistry` (non-upgradeable) encodes `initialize(InitializeParams)`: the selector must not move.
        const initSelector = (abi: readonly unknown[]) => {
            const fn = (abi as { type: string; name: string; inputs: { type: string; components?: { type: string }[] }[] }[])
                .find((entry) => entry.type === "function" && entry.name === "initialize")!;
            const tuple = `(${fn.inputs[0].components!.map((c) => c.type).join(",")})`;
            return toFunctionSelector(`initialize(${tuple})`);
        };
        expect(initSelector(current.abi)).to.equal(initSelector(legacy.abi));
    });

    it("beacon upgrade from the side-bet vault: state preserved, old controller and strangers get OnlyEngine", async function () {
        const [admin, alice, stranger] = await viem.getWalletClients();
        const s = await deployProtocolStack();
        await s.sideBet.write.setSideBetsDisabled([true]);
        const token = await viem.deployContract("MockUSDC");
        const legacyImpl = await viem.deployContract("LegacySideBetBankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [legacyImpl.address, admin.account.address]);
        await s.registry.write.setVaultBeacon([beacon.address]);
        await s.registry.write.createMarket([{ asset: token.address, bankAdmin: admin.account.address, minBet: 1_000_000n }]);
        const bankAddress = (await s.registry.read.getMarket([1])).bank;
        const legacy = await viem.getContractAt("LegacySideBetBankVault4626", bankAddress);
        const controller = (await legacy.read.sideBetController()) as Address;
        expect(controller.toLowerCase()).to.equal(s.sideBet.address.toLowerCase());
        for (const who of [admin, alice]) {
            await token.write.mint([who.account.address, parseUnits("100000", 6)]);
            await token.write.approve([bankAddress, maxUint256], { account: who.account });
        }
        await legacy.write.deposit([parseUnits("50000", 6), admin.account.address]);
        await legacy.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], { account: alice.account });

        const publicClient = await viem.getPublicClient();
        const slot = (index: bigint) => publicClient.getStorageAt({ address: bankAddress, slot: toHex(BANK_VAULT_STORAGE_LOCATION + index, { size: 32 }) });
        const rawBefore = await Promise.all([0n, 1n, 2n, 3n, 4n, 5n].map(slot));
        const snapshot = {
            totalAssets: await legacy.read.totalAssets(), supply: await legacy.read.totalSupply(),
            locked: await legacy.read.lockedBetLiquidity(), minBet: await legacy.read.minBet(),
        };

        const newImpl = await viem.deployContract("BankVault4626");
        await beacon.write.upgradeTo([newImpl.address]);
        const bank = await viem.getContractAt("BankVault4626", bankAddress);
        expect(await Promise.all([0n, 1n, 2n, 3n, 4n, 5n].map(slot))).to.deep.equal(rawBefore);
        expect(BigInt(rawBefore[2]!)).to.equal(BigInt(controller));
        expect({
            totalAssets: await bank.read.totalAssets(), supply: await bank.read.totalSupply(),
            locked: await bank.read.lockedBetLiquidity(), minBet: await bank.read.minBet(),
        }).to.deep.equal(snapshot);
        expect(await bank.read.availableForSideBet()).to.equal(snapshot.totalAssets);

        const testClient = await viem.getTestClient();
        await testClient.impersonateAccount({ address: controller });
        await testClient.setBalance({ address: controller, value: parseUnits("1", 18) });
        for (const caller of [controller, stranger.account.address]) {
            const account = caller === controller ? controller : stranger.account;
            await expect(bank.write.releaseBets([1n], { account })).to.be.rejectedWith(customErrorPattern("OnlyEngine()"));
            await expect(bank.write.payoutBatch([[{ player: caller, amount: 1n }]], { account }))
                .to.be.rejectedWith(customErrorPattern("OnlyEngine()"));
            await expect(bank.write.transferOut([caller, 1n], { account })).to.be.rejectedWith(customErrorPattern("OnlyEngine()"));
        }
        await testClient.stopImpersonatingAccount({ address: controller });

        // The open round settles normally on the upgraded vault (real scheduler / engine).
        const aliceBefore = await token.read.balanceOf([alice.account.address]);
        const { time } = await import("@nomicfoundation/hardhat-network-helpers");
        const { fulfillVrfForGlobalRound, runParallelLanesUntilVrfPending } = await import("./helpers/parallelUpkeep");
        await time.increase(600);
        await runParallelLanesUntilVrfPending(s.engine, s.scheduler);
        await fulfillVrfForGlobalRound(publicClient, s.vrf, s.engine, 1n, 7n);
        await runParallelLanesUntilIdle(s.scheduler);
        expect(await token.read.balanceOf([alice.account.address])).to.equal(aliceBefore + parseUnits("360", 6));
        expect(await bank.read.lockedBetLiquidity()).to.equal(0n);
    });

    it("new markets ignore InitializeParams.sideBetController", async function () {
        const s = await deployMaskFixture();
        const raw = await s.publicClient.getStorageAt({ address: s.bank.address, slot: toHex(BANK_VAULT_STORAGE_LOCATION + 2n, { size: 32 }) });
        expect(BigInt(raw!)).to.equal(0n);
    });
});

type FuzzBet = RecordedLeg[];

function randomLegs(rand: () => number, s: MaskFixture, player: Address): FuzzBet {
    const count = 1 + Math.floor(rand() * 4);
    const legs: RecordedLeg[] = [];
    for (let i = 0; i < count; i++) {
        const amount = s.unit + BigInt(Math.floor(rand() * 50_000)) * (s.unit / 1000n) + BigInt(Math.floor(rand() * 997));
        const kind = Math.floor(rand() * 6);
        if (kind === 0) legs.push({ player, betType: 1n, number: BigInt(Math.floor(rand() * 37)), amount });
        else if (kind === 1) legs.push({ player, betType: rand() < 0.5 ? 8n : 9n, number: 0n, amount });
        else if (kind === 2) legs.push({ player, betType: rand() < 0.5 ? 6n : 7n, number: BigInt(1 + Math.floor(rand() * 3)), amount });
        else {
            const size = 2 + Math.floor(rand() * 23);
            const numbers = new Set<number>();
            while (numbers.size < size) numbers.add(Math.floor(rand() * 37));
            legs.push({ player, ...maskLeg([...numbers], amount, { presetId: BigInt(Math.floor(rand() * 512)) }) });
        }
    }
    return legs;
}

describe("Mask bets v1 — properties (seeded fuzz)", function () {
    this.timeout(1_200_000);

    it("payout = floor(amount × 36 / |S|) and |S| × payout ≤ amount × 36 for random (mask, amount)", function () {
        const rand = prng(20261105);
        for (let i = 0; i < 20_000; i++) {
            const size = 2 + Math.floor(rand() * 23);
            const amount = BigInt(Math.floor(rand() * 2 ** 48)) * BigInt(1 + Math.floor(rand() * 1e6)) + 1n;
            const payout = maskPayout(amount, size);
            expect(BigInt(size) * payout <= amount * 36n).to.equal(true);
            expect(amount * 36n - BigInt(size) * payout < BigInt(size)).to.equal(true);
        }
    });

    for (const [seed, decimals] of [[1, 6], [2, 18], [3, 6]] as const) {
        it(`random classic + mask sequences: NAV unchanged per bet, every outcome ≤ buffered liability, exact settlement (seed ${seed})`, async function () {
            const s = await deployMaskFixture({ decimals, maxLegs: LAUNCH_MAX_LEGS, maxBps: FULL_BPS, liquidityUnits: 500_000n });
            const rand = prng(seed);
            const players = [s.alice, s.bob, s.carol];
            const before = await Promise.all(players.map((p) => s.token.read.balanceOf([p.account.address])));
            const all: RecordedLeg[] = [];
            for (let i = 0; i < 24; i++) {
                const player = players[i % 3];
                const legs = randomLegs(rand, s, player.account.address);
                const nav = await s.bank.read.totalAssets();
                await place(s, legs, player);
                expect(await s.bank.read.totalAssets(), `bet ${i}`).to.equal(nav);
                all.push(...legs);
            }
            expect(all.some((leg) => leg.betType === BET_MASK)).to.equal(true);
            const liability = await bufferedLiability(s, 1n);
            const outcomes = Array.from({ length: 37 }, (_, n) => all.reduce((sum, leg) => sum + legPayout(leg, n), 0n));
            for (const [n, paid] of outcomes.entries()) expect(paid <= liability, `number ${n}`).to.equal(true);

            const winning = Math.floor(rand() * 37);
            await settleRound(s, winning);
            for (const [index, player] of players.entries()) {
                const mine = all.filter((leg) => leg.player === player.account.address);
                const staked = mine.reduce((sum, leg) => sum + leg.amount, 0n);
                const won = mine.reduce((sum, leg) => sum + legPayout(leg, winning), 0n);
                expect(await s.token.read.balanceOf([player.account.address])).to.equal(before[index] - staked + won);
            }
            const masks = all.filter((leg) => leg.betType === BET_MASK);
            for (const leg of masks) expect(popcount(leg.number & ((1n << 37n) - 1n))).to.be.within(2, 24);
        });
    }
});
