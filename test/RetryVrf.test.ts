import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { deployRouletteEngineLibraries } from "../scripts/utils/deployRouletteEngineLibraries";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";

const USDC = (v: string) => parseUnits(v, 6);
const laneKey = () => ("0x" + "11".repeat(32)) as `0x${string}`;
const VRF_RETRY_DELAY_SEC = 24 * 60 * 60;

async function deployPendingVrfStack() {
    const [admin, alice] = await viem.getWalletClients();
    const stack = await deployProtocolStack({ maxPayoutsPerCall: 5 });
    const { engine, scheduler, registry, vrf, deployer } = stack;
    const usdc = await viem.deployContract("MockUSDC");
    const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

    await usdc.write.mint([admin.account.address, USDC("5000")]);
    await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
    await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
    await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
        account: admin.account,
    });

    await time.increase(550);
    const [, triggerData] = await scheduler.read.checkUpkeep(["0x"]);
    await scheduler.write.performUpkeep([triggerData]);

    return { admin, alice, engine, scheduler, vrf, deployer, usdc, bank };
}

describe("retryVrf", function () {
    it("reverts before VRF has been requested", async function () {
        const { engine } = await deployProtocolStack();
        await expect(engine.write.retryVrf()).to.be.rejected;
    });

    it("reverts when called before the 24 hour delay", async function () {
        const { engine, deployer } = await deployPendingVrfStack();
        await expect(engine.write.retryVrf({ account: deployer.account })).to.be.rejected;
        expect(await engine.read.hasPendingVrf()).to.equal(true);
    });

    it("rejects non-admin callers even after the delay", async function () {
        const { engine, alice } = await deployPendingVrfStack();
        await time.increase(VRF_RETRY_DELAY_SEC);
        await expect(engine.write.retryVrf({ account: alice.account })).to.be.rejected;
        expect(await engine.read.hasPendingVrf()).to.equal(true);
    });

    it("lets admin request a new VRF after 24 hours and ignores the stale callback", async function () {
        const { engine, vrf, deployer } = await deployPendingVrfStack();

        await time.increase(VRF_RETRY_DELAY_SEC);
        await engine.write.retryVrf({ account: deployer.account });

        expect(await engine.read.hasPendingVrf()).to.equal(true);
        const gr = await engine.read.globalRoundState([1n]);
        expect(gr.vrfRequested).to.equal(true);
        expect(gr.vrfFulfilled).to.equal(false);

        await expect(vrf.write.fulfill([engine.address, 1n, 7n])).to.be.rejected;

        await vrf.write.fulfill([engine.address, 2n, 17n]);
        const fulfilled = await engine.read.roundOutcome([1n]);
        expect(fulfilled[0]).to.equal(true);
        expect(fulfilled[1]).to.equal(17);
        expect(await engine.read.hasPendingVrf()).to.equal(false);
    });

    it("enforces the delay again after a retry", async function () {
        const { engine, deployer } = await deployPendingVrfStack();

        await time.increase(VRF_RETRY_DELAY_SEC);
        await engine.write.retryVrf({ account: deployer.account });
        await expect(engine.write.retryVrf({ account: deployer.account })).to.be.rejected;

        await time.increase(VRF_RETRY_DELAY_SEC);
        await engine.write.retryVrf({ account: deployer.account });
        expect(await engine.read.hasPendingVrf()).to.equal(true);
    });

    it("reverts after VRF has already been fulfilled", async function () {
        const { engine, vrf } = await deployPendingVrfStack();
        await vrf.write.fulfill([engine.address, 1n, 7n]);
        await expect(engine.write.retryVrf()).to.be.rejected;
        await expect(vrf.write.fulfill([engine.address, 1n, 8n])).to.be.rejected;
    });

    it("allows retry on a pre-upgrade round with no vrfRequestedAt once lockAt + delay elapsed", async function () {
        const { engine, vrf, deployer } = await deployPendingVrfStack();
        const { engineLinks } = await deployRouletteEngineLibraries(deployer.account);
        const harnessImpl = await viem.deployContract(
            "RouletteEngineHarness",
            [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
            { libraries: engineLinks },
        );
        await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
        const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);

        await harness.write.harnessSetVrfRequestedAt([1n, 0n]);
        await expect(engine.write.retryVrf({ account: deployer.account })).to.be.rejected;

        await time.increase(VRF_RETRY_DELAY_SEC);
        await engine.write.retryVrf({ account: deployer.account });
        await vrf.write.fulfill([engine.address, 2n, 11n]);
        expect((await engine.read.roundOutcome([1n]))[1]).to.equal(11);
    });

    it("allows retry immediately when both timestamps are unset (pre-upgrade stuck round)", async function () {
        const { engine, vrf, deployer } = await deployPendingVrfStack();
        const { engineLinks } = await deployRouletteEngineLibraries(deployer.account);
        const harnessImpl = await viem.deployContract(
            "RouletteEngineHarness",
            [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
            { libraries: engineLinks },
        );
        await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
        const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);
        await harness.write.harnessSetVrfRequestedAt([1n, 0n]);
        await harness.write.harnessClearRoundLockAt([1n]);

        await engine.write.retryVrf({ account: deployer.account });
        await vrf.write.fulfill([engine.address, 2n, 4n]);
        expect((await engine.read.roundOutcome([1n]))[1]).to.equal(4);
    });
});
