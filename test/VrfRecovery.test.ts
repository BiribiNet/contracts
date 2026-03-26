import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseEther, parseEventLogs, toHex, zeroAddress } from "viem";

import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

const MAX_UINT256 = 2n ** 256n - 1n;
const VRF_RECOVERY_TIMEOUT = 300n; // 5 minutes

async function advanceThroughLockToVrfWindow(rouletteProxy: any) {
  let s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  }
  const [lockNeeded, lockData] = await rouletteProxy.read.checkUpkeep(["0x"]);
  if (!lockNeeded) throw new Error("expected pre-VRF lock upkeep");
  await rouletteProxy.write.performUpkeep([lockData]);
  s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  }
}

async function placeBetAndAdvanceToVrf(
  rouletteProxy: any,
  stakedBrbProxy: any,
  brb: any,
  player: any,
  admin: any,
  publicClient: any
) {
  // Stake liquidity
  const stakeAmount = parseEther("1000");
  await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player.account });
  await stakedBrbProxy.write.deposit([stakeAmount, player.account.address, 0n], { account: player.account });

  // Place a bet
  const betAmount = parseEther("1");
  const betData = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "uint256[]", name: "amounts" },
      { type: "uint256[]", name: "betTypes" },
      { type: "uint256[]", name: "numbers" },
    ] }],
    [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }],
  );
  await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });

  // Advance to VRF window and trigger VRF request
  await advanceThroughLockToVrfWindow(rouletteProxy);
  const [needsVrf, vrfPerformData] = await rouletteProxy.read.checkUpkeep(["0x01"]);
  if (!needsVrf) throw new Error("VRF upkeep not ready");
  const txVrf = await rouletteProxy.write.performUpkeep([vrfPerformData]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txVrf });
  const logs = parseEventLogs({
    abi: rouletteProxy.abi,
    eventName: "VrfRequested",
    logs: receipt.logs,
  });
  if (!logs.length) throw new Error("VrfRequested event not found");
  return logs[0].args.requestId;
}

describe("VRF Recovery", function () {

  describe("initializeV2 & setVrfRecoveryTimeout", function () {
    it("Should initialize VRF recovery timeout via initializeV2", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [, , recoveryTimeout] = await rouletteProxy.read.getVrfRecoveryState();
      expect(recoveryTimeout).to.equal(VRF_RECOVERY_TIMEOUT);
    });

    it("Should allow admin to update VRF recovery timeout", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      await rouletteProxy.write.setVrfRecoveryTimeout([600n]);
      const [, , recoveryTimeout] = await rouletteProxy.read.getVrfRecoveryState();
      expect(recoveryTimeout).to.equal(600n);
    });

    it("Should reject timeout below 60 seconds", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      await expect(rouletteProxy.write.setVrfRecoveryTimeout([30n])).to.be.rejected;
    });

    it("Should reject setVrfRecoveryTimeout from non-admin", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      await expect(
        rouletteProxy.write.setVrfRecoveryTimeout([300n], { account: player1.account })
      ).to.be.rejected;
    });
  });

  describe("VRF request tracking", function () {
    it("Should track VRF request timestamp and id after VRF trigger", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      // Before VRF: no pending request
      const [reqId0, reqTs0, , isPending0] = await rouletteProxy.read.getVrfRecoveryState();
      expect(isPending0).to.be.false;
      expect(reqTs0).to.equal(0n);

      const requestId = await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // After VRF trigger: should have pending request
      const [reqId1, reqTs1, , isPending1] = await rouletteProxy.read.getVrfRecoveryState();
      expect(isPending1).to.be.true;
      expect(reqTs1).to.be.gt(0n);
      expect(reqId1).to.equal(requestId);
    });

    it("Should clear tracking after successful VRF fulfillment", async function () {
      const { rouletteProxy, stakedBrbProxy, brb, vrfCoordinator } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const requestId = await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // Fulfill VRF normally
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [7n, 10n]]);

      // Tracking should be cleared
      const [reqId, reqTs, , isPending] = await rouletteProxy.read.getVrfRecoveryState();
      expect(isPending).to.be.false;
      expect(reqTs).to.equal(0n);
      expect(reqId).to.equal(0n);
    });
  });

  describe("forceResolveVrf (State A recovery)", function () {
    it("Should force-resolve a stuck VRF after timeout", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      // Get round info before
      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();

      await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // VRF was requested but never fulfilled — simulate stuck state
      // Confirm roundTransitionInProgress is true
      const inTransition = await stakedBrbProxy.read.roundTransitionInProgress();
      expect(inTransition).to.be.true;

      // Wait past the timeout
      await time.increase(VRF_RECOVERY_TIMEOUT + 1n);

      // Force resolve the stuck round
      const tx = await rouletteProxy.write.forceResolveVrf([roundBefore]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // Verify ForceResolvedVrf event
      const forceResolveLogs = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: "ForceResolvedVrf",
        logs: receipt.logs,
      });
      expect(forceResolveLogs.length).to.equal(1);
      expect(forceResolveLogs[0].args.roundId).to.equal(roundBefore);

      // Verify RoundResolved event
      const roundResolvedLogs = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: "RoundResolved",
        logs: receipt.logs,
      });
      expect(roundResolvedLogs.length).to.equal(1);

      // VRF tracking should be cleared
      const [, , , isPending] = await rouletteProxy.read.getVrfRecoveryState();
      expect(isPending).to.be.false;

      // The round result should be set with winningNumber=37
      const result = await rouletteProxy.read.getRoundResult([roundBefore]);
      expect(result.set).to.be.true;
      expect(result.winningNumber).to.equal(37n);
    });

    it("Should allow cleaning upkeep to fire after force-resolve", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      await time.increase(VRF_RECOVERY_TIMEOUT + 1n);
      await rouletteProxy.write.forceResolveVrf([roundBefore]);

      // Cleaning upkeep should now be available
      const [cleaningNeeded, cleaningData] = await stakedBrbProxy.read.checkUpkeep(["0x"]);
      expect(cleaningNeeded).to.be.true;

      // Execute cleaning
      await stakedBrbProxy.write.performUpkeep([cleaningData], { account: admin.account });

      // After cleaning, roundTransitionInProgress should be false
      const inTransition = await stakedBrbProxy.read.roundTransitionInProgress();
      expect(inTransition).to.be.false;

      // Betting should be open again (round resolution flags cleared)
      const resLocked = await stakedBrbProxy.read.roundResolutionLocked();
      expect(resLocked).to.be.false;
    });

    it("Should revert forceResolveVrf before timeout elapses", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // Try to force-resolve immediately (before timeout)
      await expect(rouletteProxy.write.forceResolveVrf([roundBefore])).to.be.rejectedWith("TimeoutNotElapsed");
    });

    it("Should revert forceResolveVrf when VRF was already fulfilled (NotStuck)", async function () {
      const { rouletteProxy, stakedBrbProxy, brb, vrfCoordinator } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      const requestId = await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // Fulfill VRF normally
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [7n, 10n]]);

      await time.increase(VRF_RECOVERY_TIMEOUT + 1n);

      // Should revert because VRF was already fulfilled
      await expect(rouletteProxy.write.forceResolveVrf([roundBefore])).to.be.rejectedWith("NotStuck");
    });

    it("Should revert forceResolveVrf when timeout not configured", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Don't call initializeV2 — vrfRecoveryTimeout is 0

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      await time.increase(600n);

      await expect(rouletteProxy.write.forceResolveVrf([roundBefore])).to.be.rejectedWith("VrfRecoveryTimeoutNotSet");
    });

    it("Should revert forceResolveVrf from non-admin", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      await time.increase(VRF_RECOVERY_TIMEOUT + 1n);

      await expect(
        rouletteProxy.write.forceResolveVrf([roundBefore], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should handle late VRF callback after force-resolve gracefully", async function () {
      const { rouletteProxy, stakedBrbProxy, brb, vrfCoordinator } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const [roundBefore] = await rouletteProxy.read.getCurrentRoundInfo();
      const requestId = await placeBetAndAdvanceToVrf(rouletteProxy, stakedBrbProxy, brb, player1, admin, publicClient);

      // Force-resolve
      await time.increase(VRF_RECOVERY_TIMEOUT + 1n);
      await rouletteProxy.write.forceResolveVrf([roundBefore]);

      // Late VRF callback — the requestIdToRound mapping was deleted, so fulfillRandomWords
      // will revert with InvalidRequestId internally. The mock coordinator may swallow this,
      // but the round result should NOT be overwritten.
      // Even if the callback goes through, the force-resolved state should remain intact.
      try {
        await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [7n, 10n]]);
      } catch {
        // Expected to revert in production; mock may or may not revert
      }

      // Verify the force-resolved result is still intact (winningNumber=37)
      const result = await rouletteProxy.read.getRoundResult([roundBefore]);
      expect(result.set).to.be.true;
      expect(result.winningNumber).to.equal(37n);

      // VRF tracking should still be cleared
      const [, , , isPending] = await rouletteProxy.read.getVrfRecoveryState();
      expect(isPending).to.be.false;
    });
  });

  describe("forceUnlockPreVrf (State B recovery)", function () {
    it("Should unlock pre-VRF lock after timeout", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      // Stake so there's liquidity
      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      // Place a bet
      const betAmount = parseEther("1");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" },
        ] }],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }],
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });

      // Advance past game period
      const [, , gamePeriod] = await rouletteProxy.read.getConstants();
      await time.increase(gamePeriod);

      // Fire pre-VRF lock upkeep
      const [lockNeeded, lockData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      expect(lockNeeded).to.be.true;
      await rouletteProxy.write.performUpkeep([lockData]);

      // Confirm pre-VRF locked state
      const locked = await stakedBrbProxy.read.roundResolutionLocked();
      expect(locked).to.be.true;
      const inTransition = await stakedBrbProxy.read.roundTransitionInProgress();
      expect(inTransition).to.be.false;

      // Simulate: VRF upkeep never fires. Wait past timeout.
      await time.increase(VRF_RECOVERY_TIMEOUT + 20n);

      // Force unlock
      const tx = await rouletteProxy.write.forceUnlockPreVrf();
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // Verify event
      const unlockLogs = parseEventLogs({
        abi: rouletteProxy.abi,
        eventName: "ForceUnlockedPreVrf",
        logs: receipt.logs,
      });
      expect(unlockLogs.length).to.equal(1);

      // Lock should be cleared
      const lockedAfter = await stakedBrbProxy.read.roundResolutionLocked();
      expect(lockedAfter).to.be.false;
    });

    it("Should revert forceUnlockPreVrf before timeout", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      const betAmount = parseEther("1");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" },
        ] }],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }],
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });

      const [, , gamePeriod] = await rouletteProxy.read.getConstants();
      await time.increase(gamePeriod);

      const [lockNeeded, lockData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      expect(lockNeeded).to.be.true;
      await rouletteProxy.write.performUpkeep([lockData]);

      // Try to unlock before timeout (only advance a small amount past lock)
      await time.increase(20n);
      await expect(rouletteProxy.write.forceUnlockPreVrf()).to.be.rejectedWith("TimeoutNotElapsed");
    });

    it("Should revert forceUnlockPreVrf when not in locked state", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      // Not in locked state — should revert
      await expect(rouletteProxy.write.forceUnlockPreVrf()).to.be.rejectedWith("NotStuck");
    });

    it("Should revert forceUnlockPreVrf from non-admin", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await rouletteProxy.write.initializeV2([VRF_RECOVERY_TIMEOUT]);

      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      const betAmount = parseEther("1");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" },
        ] }],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }],
      );
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: admin.account });

      const [, , gamePeriod] = await rouletteProxy.read.getConstants();
      await time.increase(gamePeriod);

      const [lockNeeded, lockData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      await rouletteProxy.write.performUpkeep([lockData]);

      await time.increase(VRF_RECOVERY_TIMEOUT + 20n);

      await expect(
        rouletteProxy.write.forceUnlockPreVrf({ account: player1.account })
      ).to.be.rejected;
    });
  });
});
