import hre, { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { keccak256, zeroAddress, type Address } from "viem";

import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeMultiBet } from "./helpers/multiBetEncode";
import { fulfillVrfForGlobalRound, runParallelLanesUntilGlobalRound, runParallelLanesUntilVrfPending } from "./helpers/parallelUpkeep";

// The scripts are plain CommonJS (same style as the incident scripts) and run here on the local Hardhat
// network only (chain 31337, never a fork): `local` mode refuses anything else.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Upgrade = require("../scripts/mask-bets-v1-mainnet.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Activate = require("../scripts/mask-bets-v1-activate.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Common = require("../scripts/mask-bets-v1-common.cjs");

const SIX = 1_000_000n;
const EIGHTEEN = 10n ** 18n;

/**
 * Local replica of the Arbitrum One shape: engine on its current implementation with the ten pre-mask
 * libraries in use, banks behind a beacon running the previous vault (side-bet surface still present),
 * SideBet disabled. `d` is the deployment description the scripts read from deployments/arbitrum-one.json
 * on mainnet.
 */
async function deployLegacyShape() {
    const s = await deployProtocolStack({ roundDuration: 3600 });
    const legacyImpl = await viem.deployContract("LegacySideBetBankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [legacyImpl.address, s.admin]);
    await s.registry.write.setVaultBeacon([beacon.address]);
    const banks: Address[] = [];
    for (const [token, unit] of [["MockUSDC", SIX], ["MockDAI", EIGHTEEN]] as const) {
        const asset = await viem.deployContract(token);
        await s.registry.write.createMarket([{ asset: asset.address, bankAdmin: s.admin, minBet: unit }]);
        const marketId = banks.length + 1;
        const bank = (await s.registry.read.getMarket([marketId])).bank;
        await asset.write.mint([s.admin, 1_000_000n * unit]);
        await asset.write.approve([bank, 1_000_000n * unit]);
        const vault = await viem.getContractAt("BankVault4626", bank);
        await vault.write.deposit([100_000n * unit, s.admin]);
        banks.push(bank);
    }
    await s.sideBet.write.setSideBetsDisabled([true]);
    const publicClient = await viem.getPublicClient();
    const { rouletteMaskBetLib: _new, ...linkedLibraries } = s.linkedLibraries;
    const engineImplementation = s.engineImplementation.address;
    const d = {
        label: "local", chainId: 31337, admin: s.admin, engine: s.engine.address, engineImplementation,
        beacon: beacon.address, bankVaultImplementation: legacyImpl.address,
        bankVaultRuntimeHash: keccak256((await publicClient.getCode({ address: legacyImpl.address }))!),
        banks, registry: s.registry.address, sideBet: s.sideBet.address, linkedLibraries,
        engineConstructorArgs: [s.vrf.address, await s.engine.read.VRF_KEY_HASH_2_GWEI(), await s.engine.read.VRF_KEY_HASH_30_GWEI(),
            await s.engine.read.VRF_KEY_HASH_150_GWEI(), await s.engine.read.VRF_CONFIRMATIONS(), await s.engine.read.BRB_REFERRAL()],
        // Locally the ten existing libraries are the current build, so only the new one is deployed.
        expectedRedeploy: ["RouletteMaskBetLib"],
    };
    return { s, d, banks, beacon, legacyImpl, publicClient };
}

const options = (d: unknown) => ({ provider: hre.ethers.provider, d, network: "local", lockPath: false });

describe("Mask bets v1 — mainnet upgrade script (local Hardhat network only)", function () {
    this.timeout(300_000);

    it("dry run: passes the preflight, plans 4 deployments + engine then beacon upgrade, sends nothing", async function () {
        const { d } = await deployLegacyShape();
        const nonce = await hre.ethers.provider.getTransactionCount(d.admin);
        const plan = await Upgrade.planUpgrade(options(d));
        expect(await hre.ethers.provider.getTransactionCount(d.admin)).to.equal(nonce);
        expect(plan.steps.map((s: { label: string }) => s.label)).to.deep.equal([
            "Deploy RouletteMaskBetLib", "Deploy RouletteEngine implementation", "Deploy BankVault4626 implementation",
            "Upgrade RouletteEngine proxy (UUPS, masks disabled)", "Upgrade BankVault4626 beacon",
        ]);
        expect(plan.steps[3].to).to.equal(d.engine);
        expect(plan.steps[4].to).to.equal(d.beacon);
        expect(plan.checks.window.phase).to.equal("Open");
        expect(plan.checks.storage.appended).to.have.length(5);
        expect(plan.checks.libraries.rows.filter((r: { action: string }) => r.action === "reuse")).to.have.length(10);
        expect(Upgrade.printPlan(plan, d)).to.include("DRY RUN");
    });

    it("executes the plan: engine first, then beacon; post-checks; masks disabled until activation", async function () {
        const { s, d, banks, beacon } = await deployLegacyShape();
        const signer = await hre.ethers.getSigner(d.admin);
        const before = await Promise.all(banks.map(async (b) => {
            const v = await viem.getContractAt("BankVault4626", b);
            return [await v.read.totalAssets(), await v.read.totalSupply()];
        }));
        const reportPath = `${hre.config.paths.cache}/mask-bets-v1-local-execution.json`;
        const report = await Upgrade.executeUpgrade({ ...options(d), signer, reportPath });
        expect(report.status).to.equal("passed");
        expect(report.transactions.map((t: { status: string }) => t.status)).to.deep.equal(Array(5).fill("confirmed"));
        // Engine upgraded strictly before the beacon.
        expect(report.transactions[3].blockNumber).to.be.lessThan(report.transactions[4].blockNumber);
        expect(await Common.implementationOf(hre.ethers.provider, d.engine)).to.equal(report.plannedAddresses.RouletteEngine);
        expect((await beacon.read.implementation()).toLowerCase()).to.equal(report.plannedAddresses.BankVault4626.toLowerCase());
        expect(report.engineUpgrade.maskState.every((m: { maxLegsPerRound: number }) => m.maxLegsPerRound === 0)).to.equal(true);
        for (const [i, b] of banks.entries()) {
            const v = await viem.getContractAt("BankVault4626", b);
            expect([await v.read.totalAssets(), await v.read.totalSupply()]).to.deep.equal(before[i]);
            expect(await v.read.availableForSideBet()).to.equal(await v.read.totalAssets());
        }
        // Masks rejected until activation; activation dry run then execution for market 1 only.
        const mask = encodeMultiBet([{ betType: 16n, number: (1n << 7n) | (1n << 8n), amount: SIX }]);
        const usdcBank = await viem.getContractAt("BankVault4626", banks[0]);
        await expect(usdcBank.write.placeBet([SIX, mask, zeroAddress])).to.be.rejected;
        const settings = [Activate.parseMarketSetting("1:448:1000")];
        const plan = await Activate.planActivation({ ...options(d), settings });
        expect(plan.calls[0].before.maxLegsPerRound).to.equal(0);
        const activation = await Activate.executeActivation({ ...options(d), signer, settings });
        expect(activation.transactions[0].after).to.deep.equal({ maxLegsPerRound: 448, maxLiabilityBps: 1000 });
        // A mask and a classic bet now settle through the real scheduler.
        await usdcBank.write.placeBet([SIX, mask, zeroAddress]);
        await usdcBank.write.placeBet([SIX, encodeMultiBet([{ betType: 1n, number: 7n, amount: SIX }]), zeroAddress]);
        const round = await s.engine.read.currentGlobalRound();
        await time.increase(3700);
        await runParallelLanesUntilVrfPending(s.engine, s.scheduler);
        await fulfillVrfForGlobalRound(await viem.getPublicClient(), s.vrf, s.engine, round, 7n);
        await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, round + 1n);
        expect((await s.engine.read.marketRoundStateByRound([round, 1])).settled).to.equal(true);
        // Emergency disable is an explicit 0:0.
        await Activate.executeActivation({ ...options(d), signer, settings: [Activate.parseMarketSetting("1:0:0")] });
        await expect(usdcBank.write.placeBet([SIX, mask, zeroAddress])).to.be.rejected;
    });

    it("refuses while the round is Settling, with the VRF pending or fulfilled", async function () {
        const { s, d, banks } = await deployLegacyShape();
        const usdcBank = await viem.getContractAt("BankVault4626", banks[0]);
        await usdcBank.write.placeBet([SIX, encodeMultiBet([{ betType: 1n, number: 7n, amount: SIX }]), zeroAddress]);
        const round = await s.engine.read.currentGlobalRound();
        await time.increase(3700);
        await runParallelLanesUntilVrfPending(s.engine, s.scheduler);
        // The engine enters Settling in the VRF request transaction (no separate lock since the CRE migration).
        expect(await s.engine.read.hasPendingVrf()).to.equal(true);
        await expect(Upgrade.planUpgrade(options(d))).to.be.rejectedWith(/Settling/);
        await fulfillVrfForGlobalRound(await viem.getPublicClient(), s.vrf, s.engine, round, 7n);
        expect(Number(await s.engine.read.roundPhase([round]))).to.equal(3);
        await expect(Upgrade.planUpgrade(options(d))).to.be.rejectedWith(/Settling/);
        await runParallelLanesUntilGlobalRound(s.engine, s.scheduler, round + 1n);
        await Upgrade.planUpgrade(options(d));
    });

    it("refuses while side bets are enabled", async function () {
        const { s, d } = await deployLegacyShape();
        await s.sideBet.write.setSideBetsDisabled([false]);
        await expect(Upgrade.planUpgrade(options(d))).to.be.rejectedWith(/sideBetsDisabled/);
    });

    it("refuses when the live beacon implementation is not the one in the manifest", async function () {
        const { d, beacon } = await deployLegacyShape();
        const other = await viem.deployContract("LegacySideBetBankVault4626");
        await beacon.write.upgradeTo([other.address]);
        await expect(Upgrade.planUpgrade(options(d))).to.be.rejectedWith(/Beacon implementation differs/);
    });

    it("refuses an unexpected library redeploy set, a wrong signer, a non-admin owner and a fork-less mainnet mode", async function () {
        const { d } = await deployLegacyShape();
        await expect(Upgrade.planUpgrade(options({ ...d, expectedRedeploy: [] }))).to.be.rejectedWith(/redeploy set/);
        const [, stranger] = await hre.ethers.getSigners();
        await expect(Upgrade.executeUpgrade({ ...options(d), signer: stranger, reportPath: `${hre.config.paths.cache}/x.json` }))
            .to.be.rejectedWith(/not the protocol admin/);
        await expect(Upgrade.planUpgrade(options({ ...d, admin: stranger.address }))).to.be.rejectedWith(/DEFAULT_ADMIN_ROLE/);
        await expect(Upgrade.planUpgrade({ ...options(d), network: "mainnet" })).to.be.rejectedWith(/Unexpected chain/);
    });

    it("activation refuses implicit values, values above the launch cap and a not-yet-upgraded engine", async function () {
        const { d } = await deployLegacyShape();
        expect(() => Activate.parseArgs([])).to.throw(/no default values/);
        expect(() => Activate.parseArgs(["--market", "1:448"])).to.throw(/Expected --market/);
        expect(() => Activate.parseArgs(["--market", "1:1024:1000"])).to.throw(/launch cap 448/);
        expect(() => Activate.parseArgs(["--market", "1:70000:1000", "--allow-above-launch-cap"])).to.throw(/65535/);
        expect(() => Activate.parseArgs(["--market", "1:10:10001"])).to.throw(/10000/);
        expect(() => Activate.parseArgs(["--market", "1:448:0"])).to.throw(/maxLiabilityBps 0/);
        expect(Activate.parseArgs(["--market", "1:1024:1000", "--allow-above-launch-cap"]).settings[0].maxLegsPerRound).to.equal(1024);
        await expect(Activate.planActivation({ ...options(d), settings: [Activate.parseMarketSetting("1:448:1000")] }))
            .to.be.rejectedWith(/pre-mask implementation/);
    });
});
