import { viem } from "hardhat";

import { expect } from "chai";
import { getAddress, parseUnits } from "viem";

import {
    BPS_DENOMINATOR,
    DEFAULT_LIQUIDITY_SAFETY_BPS,
    HOUSE_EDGE,
    MAX_MULTIPLIER_BPS,
    MIN_MULTIPLIER_BPS,
    SIDE_BET_TEMPLATES,
    SIDE_BET_TYPE,
    buildCatalogueForMarket,
    computeMaxStake,
    matchesConfig,
    toConfigStruct,
    type SideBetCatalogueEntry,
} from "../scripts/utils/sideBetCatalogue";

import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";

const MARKET_ID = 1;
const USDC = (value: string): bigint => parseUnits(value, 6);

/** Mirrors `scripts/seedSideBetConfigs.ts`: create the template, then activate its stake limits. */
async function seedEntry(
    sideBet: Awaited<ReturnType<typeof deployFixture>>["sideBet"],
    entry: SideBetCatalogueEntry,
    minStake: bigint,
    maxStake: bigint,
    account: { address: `0x${string}` },
): Promise<bigint> {
    await sideBet.write.addConfig([toConfigStruct(entry)], { account });
    const configId = (await sideBet.read.configCount()) - 1n;
    await sideBet.write.setConfigStakeLimits([configId, minStake, maxStake], { account });
    return configId;
}

async function deployFixture() {
    const [admin] = await viem.getWalletClients();

    const usdc = await viem.deployContract("MockUSDC");
    const roundEngine = await viem.deployContract("MockRoundEngine");
    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);

    const { registry } = await deploySideBetRegistryStack({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
    });
    const { sideBet } = await deploySideBetProxy({
        admin: admin.account.address,
        roundEngine: roundEngine.address,
        registry: registry.address,
        minMultiplierBps: MIN_MULTIPLIER_BPS,
        maxMultiplierBps: MAX_MULTIPLIER_BPS,
    });
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
        { account: admin.account },
    );
    const market = await registry.read.getMarket([MARKET_ID]);
    const vault = await viem.getContractAt("BankVault4626", market.bank);
    expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(sideBet.address));

    await usdc.write.mint([admin.account.address, USDC("1000000")]);
    await usdc.write.approve([vault.address, USDC("1000000")], { account: admin.account });
    await vault.write.deposit([USDC("1000000"), admin.account.address], { account: admin.account });

    return { sideBet, vault, usdc, registry, admin };
}

describe("SideBet catalogue", () => {
    it("should cover every SideBetType exactly once", () => {
        const seeded = SIDE_BET_TEMPLATES.map((template) => template.betType).sort((a, b) => a - b);
        const allTypes = Object.values(SIDE_BET_TYPE).sort((a, b) => a - b);
        expect(seeded).to.deep.equal(allTypes);
    });

    it("should keep every multiplier inside the contract's band", () => {
        for (const template of SIDE_BET_TEMPLATES) {
            expect(template.multiplierBps, template.key).to.be.at.least(MIN_MULTIPLIER_BPS);
            expect(template.multiplierBps, template.key).to.be.at.most(MAX_MULTIPLIER_BPS);
        }
    });

    it("should price every template at the documented house edge", () => {
        for (const template of SIDE_BET_TEMPLATES) {
            const expectedBps = ((1 - HOUSE_EDGE) / template.winProbability) * 10_000;
            // The stored bps is rounded; allow half a percent of drift so a typo is still caught.
            expect(Math.abs(template.multiplierBps - expectedBps) / expectedBps, template.key).to.be.below(0.005);
        }
    });

    it("should use unique template keys", () => {
        const keys = SIDE_BET_TEMPLATES.map((template) => template.key);
        expect(new Set(keys).size).to.equal(keys.length);
    });

    it("should accept every catalogue entry as an on-chain config", async () => {
        const { sideBet, admin } = await deployFixture();

        for (const entry of buildCatalogueForMarket(MARKET_ID)) {
            const configId = await seedEntry(sideBet, entry, USDC("1"), USDC("100"), admin.account);
            expect(await sideBet.read.isConfigActive([configId]), entry.key).to.equal(true);

            const stored = await sideBet.read.getConfig([configId]);
            expect(Number(stored.betType), entry.key).to.equal(entry.betType);
            expect(Number(stored.windowSpins), entry.key).to.equal(entry.windowSpins);
            expect(Number(stored.multiplierBps), entry.key).to.equal(entry.multiplierBps);
        }

        expect(await sideBet.read.configCount()).to.equal(BigInt(SIDE_BET_TEMPLATES.length));
    });

    it("should let a player place a bet on every seeded config", async () => {
        const { sideBet, vault, usdc, admin } = await deployFixture();
        const [, player] = await viem.getWalletClients();

        await usdc.write.mint([player.account.address, USDC("1000")]);
        await usdc.write.approve([vault.address, USDC("1000")], { account: player.account });

        for (const entry of buildCatalogueForMarket(MARKET_ID)) {
            const configId = await seedEntry(sideBet, entry, USDC("1"), USDC("10"), admin.account);
            // Reverting here would mean the template is unplayable — the exact failure this
            // catalogue exists to prevent.
            await sideBet.write.placeBet([configId, USDC("1")], { account: player.account });
        }

        expect(await sideBet.read.betCount()).to.equal(BigInt(SIDE_BET_TEMPLATES.length));
    });

    it("should reject a bet on a config whose stake limits were never set", async () => {
        const { sideBet, vault, usdc, admin } = await deployFixture();
        const [, player] = await viem.getWalletClients();

        await usdc.write.mint([player.account.address, USDC("100")]);
        await usdc.write.approve([vault.address, USDC("100")], { account: player.account });

        const [entry] = buildCatalogueForMarket(MARKET_ID);
        await sideBet.write.addConfig([toConfigStruct(entry)], { account: admin.account });
        const configId = (await sideBet.read.configCount()) - 1n;

        // addConfig zeroes the limits regardless of what was passed, so the config is inert
        // until setConfigStakeLimits runs. This is why seeding needs two transactions.
        const stored = await sideBet.read.getConfig([configId]);
        expect(stored.minStake).to.equal(0n);
        expect(stored.maxStake).to.equal(0n);

        await expect(
            sideBet.write.placeBet([configId, USDC("1")], { account: player.account }),
        ).to.be.rejectedWith("StakeLimitsNotSet");
    });

    it("should recognise an already-seeded template so a re-run creates nothing", async () => {
        const { sideBet, admin } = await deployFixture();
        const entries = buildCatalogueForMarket(MARKET_ID);

        for (const entry of entries) {
            await seedEntry(sideBet, entry, USDC("1"), USDC("100"), admin.account);
        }
        const countAfterFirstPass = await sideBet.read.configCount();

        // Second pass: every entry must match an existing config, so the seed script skips it.
        for (const entry of entries) {
            let found = false;
            for (let configId = 0n; configId < countAfterFirstPass; configId += 1n) {
                const raw = await sideBet.read.getConfig([configId]);
                const onChain = {
                    marketId: Number(raw.marketId),
                    betType: Number(raw.betType),
                    color: Number(raw.color),
                    targetNumber: Number(raw.targetNumber),
                    targetCount: Number(raw.targetCount),
                    redRatioBps: Number(raw.redRatioBps),
                    windowSpins: Number(raw.windowSpins),
                    multiplierBps: Number(raw.multiplierBps),
                    minStake: raw.minStake,
                    maxStake: raw.maxStake,
                };
                if (onChain.marketId !== 0 && matchesConfig(entry, onChain)) {
                    found = true;
                    break;
                }
            }
            expect(found, `${entry.key} should already be present`).to.equal(true);
        }

        expect(await sideBet.read.configCount()).to.equal(countAfterFirstPass);
    });

    it("should make getConfig revert once a config is removed, not return a zeroed struct", async () => {
        const { sideBet, admin } = await deployFixture();
        const [entry] = buildCatalogueForMarket(MARKET_ID);
        const configId = await seedEntry(sideBet, entry, USDC("1"), USDC("100"), admin.account);

        await sideBet.write.removeConfig([configId], { account: admin.account });

        expect(await sideBet.read.isConfigActive([configId])).to.equal(false);
        // Consumers must gate on isConfigActive: getConfig reverts rather than reporting
        // marketId == 0, so any scan that calls it blindly dies on the first removed id.
        await expect(sideBet.read.getConfig([configId])).to.be.rejectedWith("ConfigInactive");
    });
});

describe("SideBet catalogue stake sizing", () => {
    it("should cap a max stake at what the vault can actually back", () => {
        // 10 000 units of liquidity, 10x multiplier, 20% safety: the vault must cover 9x the
        // stake, so 2 000 / 9 = 222 units.
        const maxStake = computeMaxStake(10_000n, 100_000, DEFAULT_LIQUIDITY_SAFETY_BPS);
        expect(maxStake).to.equal(222n);
    });

    it("should return zero when the multiplier leaves no room", () => {
        expect(computeMaxStake(10_000n, Number(BPS_DENOMINATOR))).to.equal(0n);
    });

    it("should shrink the max stake as the multiplier grows", () => {
        const liquidity = parseUnits("1000000", 6);
        const atShortOdds = computeMaxStake(liquidity, 73_977);
        const atLongOdds = computeMaxStake(liquidity, 601_266);
        expect(atLongOdds).to.be.below(atShortOdds);
    });

    it("should size a stake the vault genuinely honours", async () => {
        const { sideBet, vault, usdc, admin } = await deployFixture();
        const [, player] = await viem.getWalletClients();

        const available = await sideBet.read.availableVaultLiquidity([MARKET_ID]);
        const longestOdds = SIDE_BET_TEMPLATES.reduce((worst, template) =>
            template.multiplierBps > worst.multiplierBps ? template : worst,
        );
        const maxStake = computeMaxStake(available, longestOdds.multiplierBps);

        await usdc.write.mint([player.account.address, maxStake]);
        await usdc.write.approve([vault.address, maxStake], { account: player.account });

        const entry = { ...longestOdds, marketId: MARKET_ID };
        const configId = await seedEntry(sideBet, entry, 1n, maxStake, admin.account);

        // The whole point of computeMaxStake: a bet at exactly maxStake must not trip
        // BankVault4626.InsufficientSideBetLiquidity.
        await sideBet.write.placeBet([configId, maxStake], { account: player.account });
        expect(await sideBet.read.betCount()).to.equal(1n);
    });

    it("should leave a config unactivatable when the vault is too thin", async () => {
        const { sideBet, admin } = await deployFixture();

        // A vault holding 10.95 units cannot back a 1-unit minimum at 60x — the real state of the
        // USDC market at the time of writing.
        const thinLiquidity = USDC("10.95");
        const longestOdds = SIDE_BET_TEMPLATES.reduce((worst, template) =>
            template.multiplierBps > worst.multiplierBps ? template : worst,
        );
        const maxStake = computeMaxStake(thinLiquidity, longestOdds.multiplierBps);
        expect(maxStake).to.be.below(USDC("1"));

        // The contract itself refuses the inverted range, which is why the seed script must skip
        // activation rather than push limits it knows are invalid.
        const entry = { ...longestOdds, marketId: MARKET_ID };
        await sideBet.write.addConfig([toConfigStruct(entry)], { account: admin.account });
        const configId = (await sideBet.read.configCount()) - 1n;
        await expect(
            sideBet.write.setConfigStakeLimits([configId, USDC("1"), maxStake], { account: admin.account }),
        ).to.be.rejectedWith("InvalidConfig");
    });
});
