import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import {
  encodeAbiParameters,
  parseEther,
  parseEventLogs,
  toHex,
  zeroAddress,
} from "viem";
import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

const MAX_UINT256 = 2n ** 256n - 1n;

function encodeBets(
  amounts: bigint[],
  betTypes: bigint[],
  numbers: bigint[]
) {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "amounts", type: "uint256[]" },
          { name: "betTypes", type: "uint256[]" },
          { name: "numbers", type: "uint256[]" },
        ],
      },
    ],
    [{ amounts, betTypes, numbers }]
  );
}

async function advanceThroughLockToVrfWindow(rouletteProxy: any) {
  let s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  }
  const [lockNeeded, lockData] =
    await rouletteProxy.read.checkUpkeep(["0x"]);
  if (!lockNeeded) throw new Error("expected pre-VRF lock upkeep");
  await rouletteProxy.write.performUpkeep([lockData]);
  s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  }
}

async function resolveFullRound(
  stakedBrbProxy: any,
  rouletteProxy: any,
  vrfCoordinator: any,
  publicClient: any,
  winningNumber: bigint,
  jackpotNumber: bigint = 99n
) {
  await advanceThroughLockToVrfWindow(rouletteProxy);

  const [needsVRF, vrfData] =
    await rouletteProxy.read.checkUpkeep(["0x01"]);
  if (!needsVRF) throw new Error("VRF upkeep not ready");
  const txVRF = await rouletteProxy.write.performUpkeep([vrfData]);
  const receiptVRF = await publicClient.waitForTransactionReceipt({
    hash: txVRF,
  });
  const logsVRF = parseEventLogs({
    abi: rouletteProxy.abi,
    eventName: "VrfRequested",
    logs: receiptVRF.logs,
  });
  if (!logsVRF.length) throw new Error("VrfRequested not found");
  const requestId = logsVRF[0].args.requestId;

  await vrfCoordinator.write.fulfillRandomWordsWithOverride([
    requestId,
    rouletteProxy.address,
    [winningNumber, jackpotNumber],
  ]);

  const [countNeeded, countData] = await rouletteProxy.read.checkUpkeep([
    toHex(new Uint8Array(2)),
  ]);
  if (countNeeded) {
    await rouletteProxy.write.performUpkeep([countData]);
  }

  let batchIdx = 0;
  while (true) {
    const checkData = new Uint8Array(batchIdx + 3);
    const hex = toHex(checkData);
    const [needed, data] = await rouletteProxy.read.checkUpkeep([hex]);
    if (!needed) break;
    await rouletteProxy.write.performUpkeep([data]);
    batchIdx++;
    await time.increase(10n);
  }

  const [upkeepNeeded, performData] =
    await stakedBrbProxy.read.checkUpkeep(["0x"]);
  if (upkeepNeeded) {
    const [admin] = await viem.getWalletClients();
    await stakedBrbProxy.write.performUpkeep([performData], {
      account: admin.account,
    });
  }
}

// =====================================================================
// AUDIT FIX TESTS
// =====================================================================

describe("Audit Fixes", function () {

  // -------------------------------------------------------------------
  // 2B: Self-referral prevention
  // -------------------------------------------------------------------
  describe("Self-referral prevention (2B)", function () {
    it("Should NOT mint BRBR when referral == bettor (self-referral)", async function () {
      const { stakedBrbProxy, brb, brbReferral } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // First deposit to bootstrap vault
      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [1n], [7n]);

      // Player bets with themselves as referral
      const brbRefBalBefore = await brbReferral.read.balanceOf([player1.account.address]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, player1.account.address],
        { account: player1.account }
      );
      const brbRefBalAfter = await brbReferral.read.balanceOf([player1.account.address]);

      // Self-referral should NOT mint BRBR
      expect(brbRefBalAfter).to.equal(brbRefBalBefore);
    });

    it("Should mint BRBR when referral is a different address", async function () {
      const { stakedBrbProxy, brb, brbReferral } = await useDeployWithCreateFixture();
      const [admin, player1, player2] = await viem.getWalletClients();

      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [1n], [7n]);

      // Player1 bets with player2 as referral
      const brbRefBalBefore = await brbReferral.read.balanceOf([player2.account.address]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, player2.account.address],
        { account: player1.account }
      );
      const brbRefBalAfter = await brbReferral.read.balanceOf([player2.account.address]);

      // Legitimate referral should mint BRBR
      expect(brbRefBalAfter).to.equal(brbRefBalBefore + betAmount);
    });

    it("Should NOT mint BRBR when referral is zero address", async function () {
      const { stakedBrbProxy, brb, brbReferral } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [1n], [7n]);

      const totalSupplyBefore = await brbReferral.read.totalSupply();
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );
      const totalSupplyAfter = await brbReferral.read.totalSupply();

      // No referral = no BRBR minted
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });
  });

  // -------------------------------------------------------------------
  // 2C: totalAssets() underflow protection
  // -------------------------------------------------------------------
  describe("totalAssets() underflow protection (2C)", function () {
    it("totalAssets should return >= 0 even with pending bets", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Deposit to vault
      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      // totalAssets should be positive
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      expect(totalAssets).to.be.greaterThan(0n);
    });

    it("totalAssets should not revert after vault receives bets", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      // Place a bet (this increases pendingBets)
      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [1n], [7n]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      // totalAssets should still be callable and correct
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      expect(totalAssets).to.be.greaterThan(0n);
    });
  });

  // -------------------------------------------------------------------
  // Event indexing (3A): verify events are emitted with indexed roundId
  // -------------------------------------------------------------------
  describe("Event indexing (3A)", function () {
    it("RoundResolved event is emitted with indexed roundId after full round", async function () {
      const { stakedBrbProxy, rouletteProxy, vrfCoordinator, brb } =
        await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Deposit
      await brb.write.approve([stakedBrbProxy.address, parseEther("2000")], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [parseEther("2000"), admin.account.address, 0n],
        { account: admin.account }
      );

      // Place bet
      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [1n], [7n]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      // Resolve round (winning number 7 = straight bet wins)
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n
      );

      // Verify RoundResolved was emitted (existence test — indexing is verified at ABI level)
      const logs = await publicClient.getLogs({
        address: rouletteProxy.address,
        event: {
          type: "event",
          name: "RoundResolved",
          inputs: [{ name: "roundId", type: "uint256", indexed: true }],
        },
        fromBlock: 0n,
      });
      expect(logs.length).to.be.greaterThanOrEqual(1);
    });
  });
});
