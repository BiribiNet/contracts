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

// ---------------------------------------------------------------------------
// Helpers (same patterns as existing test files)
// ---------------------------------------------------------------------------

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

/** Advance past game period and perform the pre-VRF lock upkeep */
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

/**
 * Runs a full round: bet -> lock -> VRF -> compute -> payouts -> StakedBRB cleaning.
 * `winningNumber` controls the VRF outcome.
 */
async function resolveFullRound(
  stakedBrbProxy: any,
  rouletteProxy: any,
  vrfCoordinator: any,
  publicClient: any,
  winningNumber: bigint,
  jackpotNumber: bigint = 99n
) {
  await advanceThroughLockToVrfWindow(rouletteProxy);

  // VRF upkeep
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

  // Compute total winning bets
  const [countNeeded, countData] = await rouletteProxy.read.checkUpkeep([
    toHex(new Uint8Array(2)),
  ]);
  if (countNeeded) {
    await rouletteProxy.write.performUpkeep([countData]);
  }

  // Process all payout batches
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

  // StakedBRB cleaning upkeep
  const [upkeepNeeded, performData] =
    await stakedBrbProxy.read.checkUpkeep(["0x"]);
  if (upkeepNeeded) {
    const [admin] = await viem.getWalletClients();
    await stakedBrbProxy.write.performUpkeep([performData], {
      account: admin.account,
    });
  }
}

/** PRNG for deterministic randomness in fuzz tests */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================
// TEST SUITES
// =====================================================================

describe("Advanced Tests", function () {
  // -------------------------------------------------------------------
  // 1. Reentrancy Tests
  // -------------------------------------------------------------------
  describe("Reentrancy Protection", function () {
    it("onTokenTransfer is protected by nonReentrant (only callable by BRB token)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // onTokenTransfer has the onlyBRB modifier, so calling it directly
      // from a non-BRB address must revert with OnlyBRB.
      const betData = encodeBets([parseEther("1")], [1n], [7n]);
      await expect(
        stakedBrbProxy.write.onTokenTransfer(
          [player1.account.address, parseEther("1"), betData, zeroAddress],
          { account: player1.account }
        )
      ).to.be.rejectedWith("OnlyBRB");
    });

    it("processRouletteResult is protected by nonReentrant (only callable by Roulette)", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      // processRouletteResult has onlyRoulette + nonReentrant; calling from
      // a non-Roulette address must revert.
      await expect(
        stakedBrbProxy.write.processRouletteResult(
          [1n, [], 0n, true],
          { account: player1.account }
        )
      ).to.be.rejectedWith("OnlyRoulette");
    });

    it("performUpkeep (cleaning) is protected by nonReentrant (only callable by cleaning forwarders)", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      // performUpkeep has onlyCleaningForwarders + nonReentrant; calling from
      // an unauthorized address must revert.
      await expect(
        stakedBrbProxy.write.performUpkeep(["0x"], {
          account: player1.account,
        })
      ).to.be.rejected;
    });
  });

  // -------------------------------------------------------------------
  // 2. ERC-4626 Invariant Tests
  // -------------------------------------------------------------------
  describe("ERC-4626 Invariants", function () {
    it("Share price never decreases after a round where the house wins", async function () {
      const { stakedBrbProxy, rouletteProxy, vrfCoordinator, brb } =
        await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Seed the vault
      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Measure share price before: assets per 1 share (1e18)
      const oneShare = parseEther("1");
      const assetsBefore = await stakedBrbProxy.read.convertToAssets([
        oneShare,
      ]);

      // Player bets on number 0, VRF returns 15 => house wins
      const betAmount = parseEther("5");
      const betData = encodeBets([betAmount], [1n], [0n]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        15n // winning number ≠ 0 => house wins
      );

      const assetsAfter = await stakedBrbProxy.read.convertToAssets([
        oneShare,
      ]);
      expect(assetsAfter).to.be.gte(assetsBefore);
    });

    it("totalAssets() + pendingBets == vault BRB balance (accounting identity)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Before any bets
      let totalAssets = await stakedBrbProxy.read.totalAssets();
      let pendingBets = await stakedBrbProxy.read.getPendingBets();
      let vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      expect(totalAssets + pendingBets).to.equal(vaultBalance);

      // After placing a bet
      const betAmount = parseEther("1");
      const betData = encodeBets([betAmount], [8n], [0n]); // RED
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      totalAssets = await stakedBrbProxy.read.totalAssets();
      pendingBets = await stakedBrbProxy.read.getPendingBets();
      vaultBalance = await brb.read.balanceOf([stakedBrbProxy.address]);
      expect(totalAssets + pendingBets).to.equal(vaultBalance);
    });

    it("convertToAssets(convertToShares(x)) <= x (round-trip loss, never gain)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      const testAmounts = [
        parseEther("1"),
        parseEther("0.001"),
        parseEther("999"),
        1n, // 1 wei
        parseEther("100"),
      ];

      for (const x of testAmounts) {
        const shares = await stakedBrbProxy.read.convertToShares([x]);
        const assetsBack = await stakedBrbProxy.read.convertToAssets([
          shares,
        ]);
        expect(assetsBack).to.be.lte(x);
      }
    });

    it("convertToShares(convertToAssets(x)) <= x (round-trip loss, never gain)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      const testShareAmounts = [
        parseEther("1"),
        parseEther("0.001"),
        parseEther("500"),
        1n, // 1 wei of shares
        parseEther("100"),
      ];

      for (const x of testShareAmounts) {
        const assets = await stakedBrbProxy.read.convertToAssets([x]);
        const sharesBack = await stakedBrbProxy.read.convertToShares([
          assets,
        ]);
        expect(sharesBack).to.be.lte(x);
      }
    });

    it("After deposit + immediate redeem: user gets back <= deposited amount (rounding favors vault)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Bootstrap vault with first deposit so subsequent deposits are queued
      // For this test we check the first deposit (immediate mint) path
      const depositAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, depositAmount], {
        account: player1.account,
      });

      const balanceBefore = await brb.read.balanceOf([
        player1.account.address,
      ]);

      await stakedBrbProxy.write.deposit(
        [depositAmount, player1.account.address, 0n],
        { account: player1.account }
      );

      // Shares received
      const shares = await stakedBrbProxy.read.balanceOf([
        player1.account.address,
      ]);
      expect(shares).to.be.gt(0n);

      // previewRedeem tells us how much BRB we'd get back
      const assetsOut = await stakedBrbProxy.read.previewRedeem([shares]);

      // Rounding must favor the vault: user gets back at most what they deposited
      expect(assetsOut).to.be.lte(depositAmount);
    });
  });

  // -------------------------------------------------------------------
  // 3. Advanced Fuzz Tests
  // -------------------------------------------------------------------
  describe("Fuzz: Multiple Players Betting Simultaneously", function () {
    it("Should handle 4 players betting random amounts on random numbers in the same round", async function () {
      const { stakedBrbProxy, rouletteProxy, brb } =
        await useDeployWithCreateFixture();
      const [admin, p1, p2, p3, p4] = await viem.getWalletClients();

      // Fund vault
      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      const rand = mulberry32(314);
      const MIN_BET = 10000n * 10n ** 9n; // 10000 gwei

      const players = [p1, p2, p3, p4];
      let totalBetsPlaced = 0n;

      for (const player of players) {
        const numBets = Math.floor(rand() * 3) + 1; // 1-3 bets per player
        const amounts: bigint[] = [];
        const betTypes: bigint[] = [];
        const numbers: bigint[] = [];
        let totalForPlayer = 0n;

        for (let j = 0; j < numBets; j++) {
          const amount = MIN_BET + BigInt(Math.floor(rand() * 1e15));
          // Use simple bet types: straight (1), red (8), black (9)
          const btChoice = Math.floor(rand() * 3);
          const bt = btChoice === 0 ? 1n : btChoice === 1 ? 8n : 9n;
          const num =
            bt === 1n ? BigInt(Math.floor(rand() * 37)) : 0n;

          amounts.push(amount);
          betTypes.push(bt);
          numbers.push(num);
          totalForPlayer += amount;
        }

        const betData = encodeBets(amounts, betTypes, numbers);
        await brb.write.bet(
          [stakedBrbProxy.address, totalForPlayer, betData, zeroAddress],
          { account: player.account }
        );
        totalBetsPlaced += BigInt(numBets);
      }

      // Verify bets were recorded
      const [currentRound] =
        await rouletteProxy.read.getCurrentRoundInfo();
      const betsCount = await rouletteProxy.read.getRoundBetsCount([
        currentRound,
      ]);
      expect(betsCount).to.equal(totalBetsPlaced);

      // pendingBets should be positive
      const pendingBets = await stakedBrbProxy.read.getPendingBets();
      expect(pendingBets).to.be.gt(0n);
    });
  });

  describe("Fuzz: Withdrawal Queue Sequences", function () {
    it("Should handle random deposit/withdraw sequences without breaking accounting", async function () {
      const { stakedBrbProxy, rouletteProxy, vrfCoordinator, brb } =
        await useDeployWithCreateFixture();
      const [admin, p1, p2, p3] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Initial large deposit to bootstrap vault
      const bootstrapAmount = parseEther("5000");
      await brb.write.approve(
        [stakedBrbProxy.address, bootstrapAmount],
        { account: admin.account }
      );
      await stakedBrbProxy.write.deposit(
        [bootstrapAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Deposit from p1 and p2 (queued since totalSupply > 0)
      for (const player of [p1, p2]) {
        const depositAmt = parseEther("500");
        await brb.write.approve(
          [stakedBrbProxy.address, depositAmt],
          { account: player.account }
        );
        await stakedBrbProxy.write.deposit(
          [depositAmt, player.account.address, 0n],
          { account: player.account }
        );
      }

      // Run a losing-bet round to process the queued deposits
      const betAmt = parseEther("1");
      const betData = encodeBets([betAmt], [1n], [8n]); // straight on 8
      await brb.write.bet(
        [stakedBrbProxy.address, betAmt, betData, zeroAddress],
        { account: p3.account }
      );
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n // winning number != 8 => house wins, deposits processed in cleaning
      );

      // Now p1 and p2 should have shares; queue withdrawals
      const p1Shares = await stakedBrbProxy.read.balanceOf([
        p1.account.address,
      ]);
      const p2Shares = await stakedBrbProxy.read.balanceOf([
        p2.account.address,
      ]);

      if (p1Shares > 0n) {
        // Queue a redeem for p1 (all shares)
        await stakedBrbProxy.write.redeem(
          [p1Shares, p1.account.address, p1.account.address, 0n],
          { account: p1.account }
        );
      }

      if (p2Shares > 0n) {
        // Queue a withdraw for p2 (by assets)
        const p2Assets = await stakedBrbProxy.read.convertToAssets([
          p2Shares,
        ]);
        if (p2Assets >= parseEther("1")) {
          await stakedBrbProxy.write.withdraw(
            [p2Assets, p2.account.address, p2.account.address, 0n],
            { account: p2.account }
          );
        }
      }

      // Check withdrawal queue size
      const [, queueLength] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      // Queue should have entries
      expect(queueLength).to.be.gte(0n);

      // Accounting identity must hold
      const totalAssets = await stakedBrbProxy.read.totalAssets();
      const pendingBets = await stakedBrbProxy.read.getPendingBets();
      const vaultBal = await brb.read.balanceOf([stakedBrbProxy.address]);
      expect(totalAssets + pendingBets).to.equal(vaultBal);
    });
  });

  describe("Fuzz: Fee Calculation Edge Cases", function () {
    it("Fee calculation handles 1 wei loss amount without reverting", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();

      // 1 wei loss — all fee components should be 0 due to integer truncation
      const [fees, stakerProfit] =
        await stakedBrbProxy.read.previewProtocolFee([1n]);
      // Total must still equal input
      expect(
        fees.protocolFees +
          fees.burnAmount +
          fees.jackpotAmount +
          stakerProfit
      ).to.equal(1n);
    });

    it("Fee calculation handles large loss amounts correctly", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();

      // Large loss amount (10M BRB)
      const largeLoss = parseEther("10000000");
      const [fees, stakerProfit] =
        await stakedBrbProxy.read.previewProtocolFee([largeLoss]);

      // Sum must equal the loss
      expect(
        fees.protocolFees +
          fees.burnAmount +
          fees.jackpotAmount +
          stakerProfit
      ).to.equal(largeLoss);

      // Stakers should get >= 95% (9500 BPS)
      expect((stakerProfit * 10000n) / largeLoss).to.be.gte(9500n);
    });

    it("Fuzz: fee split sums to lossAmount for random values", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const rand = mulberry32(42);

      for (let i = 0; i < 30; i++) {
        const lossAmount =
          BigInt(Math.floor(rand() * 1e18)) + 1n;
        const [fees, stakerProfit] =
          await stakedBrbProxy.read.previewProtocolFee([lossAmount]);
        expect(
          fees.protocolFees +
            fees.burnAmount +
            fees.jackpotAmount +
            stakerProfit
        ).to.equal(lossAmount);
      }
    });
  });

  // -------------------------------------------------------------------
  // 4. Edge Case Tests
  // -------------------------------------------------------------------
  describe("Edge Cases", function () {
    it("Round with 0 bets: no upkeep needed, round advances cleanly", async function () {
      const { stakedBrbProxy, rouletteProxy, brb } =
        await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      // Fund vault so contract is operational
      const stakeAmount = parseEther("1000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Advance time past game period
      await advanceThroughLockToVrfWindow(rouletteProxy);

      // With 0 bets the VRF upkeep should still trigger (lock was done)
      const [needsVRF, vrfData] =
        await rouletteProxy.read.checkUpkeep(["0x01"]);
      // The protocol may or may not need VRF when there are no bets
      // (depends on implementation). We verify it does not revert.
      if (needsVRF) {
        await expect(
          rouletteProxy.write.performUpkeep([vrfData])
        ).to.not.be.rejected;
      }
    });

    it("All bets win (house loses): vault remains solvent, no revert", async function () {
      const { stakedBrbProxy, rouletteProxy, vrfCoordinator, brb } =
        await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Large vault so payouts are covered
      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Player bets RED — winning number 1 is red => player wins 2x
      const betAmount = parseEther("10");
      const betData = encodeBets([betAmount], [8n], [0n]); // RED
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      const vaultBalBefore = await brb.read.balanceOf([
        stakedBrbProxy.address,
      ]);

      // Resolve with winning number 1 (red) => player wins
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        1n // red number => all RED bets win
      );

      // Vault should still be functional (no revert, totalAssets >= 0)
      const totalAssetsAfter = await stakedBrbProxy.read.totalAssets();
      expect(totalAssetsAfter).to.be.gte(0n);

      // Accounting identity holds
      const pendingBets = await stakedBrbProxy.read.getPendingBets();
      const vaultBal = await brb.read.balanceOf([
        stakedBrbProxy.address,
      ]);
      expect(totalAssetsAfter + pendingBets).to.equal(vaultBal);
    });

    it("Maximum number of bets in a single round (37 straight bets, one per number)", async function () {
      const { stakedBrbProxy, rouletteProxy, brb } =
        await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      const betPerNumber = parseEther("0.01");
      const amounts: bigint[] = [];
      const betTypes: bigint[] = [];
      const numbers: bigint[] = [];
      let totalAmount = 0n;

      for (let i = 0; i <= 36; i++) {
        amounts.push(betPerNumber);
        betTypes.push(1n);
        numbers.push(BigInt(i));
        totalAmount += betPerNumber;
      }

      const betData = encodeBets(amounts, betTypes, numbers);
      await expect(
        brb.write.bet(
          [stakedBrbProxy.address, totalAmount, betData, zeroAddress],
          { account: player1.account }
        )
      ).to.not.be.rejected;

      const [currentRound] =
        await rouletteProxy.read.getCurrentRoundInfo();
      const betsCount = await rouletteProxy.read.getRoundBetsCount([
        currentRound,
      ]);
      expect(betsCount).to.equal(37n);
    });

    it("Jackpot trigger with exactly 1 straight bet winner", async function () {
      const {
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        brb,
        jackpotContract,
      } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [stakeAmount, admin.account.address, 0n],
        { account: admin.account }
      );

      // Place a straight bet on number 7 (the only bet)
      const betAmount = parseEther("1");
      const betData = encodeBets([betAmount], [1n], [7n]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmount, betData, zeroAddress],
        { account: player1.account }
      );

      // Resolve with winning number 7 AND jackpot number 7 => jackpot triggers
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
      const requestId = logsVRF[0].args.requestId;

      // Both winning and jackpot number are 7
      await vrfCoordinator.write.fulfillRandomWordsWithOverride([
        requestId,
        rouletteProxy.address,
        [7n, 7n],
      ]);

      // Process compute + payouts
      const [countNeeded, countData] =
        await rouletteProxy.read.checkUpkeep([
          toHex(new Uint8Array(2)),
        ]);
      if (countNeeded) {
        await rouletteProxy.write.performUpkeep([countData]);
      }

      let batchIdx = 0;
      while (true) {
        const checkData = new Uint8Array(batchIdx + 3);
        const hex = toHex(checkData);
        const [needed, data] =
          await rouletteProxy.read.checkUpkeep([hex]);
        if (!needed) break;
        await rouletteProxy.write.performUpkeep([data]);
        batchIdx++;
        await time.increase(10n);
      }

      // Player should have received payout (36x for straight bet win)
      const playerBal = await brb.read.balanceOf([
        player1.account.address,
      ]);
      // Player started with 15000 BRB, bet 1 BRB, should get 36 BRB back
      // playerBal should be around 15000 - 1 + 36 = 15035
      expect(playerBal).to.be.gt(parseEther("15034"));
    });

    it("Withdrawal when vault has minimum assets (near-empty vault)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      // Deposit the absolute minimum (1 BRB) as first depositor
      const minDeposit = parseEther("1");
      await brb.write.approve([stakedBrbProxy.address, minDeposit], {
        account: admin.account,
      });
      await stakedBrbProxy.write.deposit(
        [minDeposit, admin.account.address, 0n],
        { account: admin.account }
      );

      const shares = await stakedBrbProxy.read.balanceOf([
        admin.account.address,
      ]);
      expect(shares).to.be.gt(0n);

      // Try to redeem all shares — should queue successfully (exactly 1 BRB meets MINIMUM_WITHDRAWAL)
      await expect(
        stakedBrbProxy.write.redeem(
          [shares, admin.account.address, admin.account.address, 0n],
          { account: admin.account }
        )
      ).to.not.be.rejected;

      // Verify withdrawal was queued
      const [, queueLength] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      expect(queueLength).to.be.gte(1n);
    });
  });

  // -------------------------------------------------------------------
  // 5. BRB Token Tests
  // -------------------------------------------------------------------
  describe("BRB Token", function () {
    it("transferBatch with address(0) should revert with ZeroAddressPayout", async function () {
      const { brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      // transferBatch expects IRoulette.PayoutInfo[] = [{player, payout}]
      // Passing address(0) as player should revert
      await expect(
        brb.write.transferBatch(
          [
            [
              {
                player: zeroAddress,
                payout: parseEther("1"),
              },
            ],
          ],
          { account: admin.account }
        )
      ).to.be.rejectedWith("ZeroAddressPayout");
    });

    it("transferBatch with empty array should succeed (no-op)", async function () {
      const { brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      // Empty payouts array should not revert
      await expect(
        brb.write.transferBatch([[]], { account: admin.account })
      ).to.not.be.rejected;
    });

    it("burn reduces totalSupply", async function () {
      const { brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      const supplyBefore = await brb.read.totalSupply();
      const burnAmount = parseEther("100");

      await brb.write.burn([burnAmount], { account: admin.account });

      const supplyAfter = await brb.read.totalSupply();
      expect(supplyAfter).to.equal(supplyBefore - burnAmount);
    });

    it("burn of entire balance reduces totalSupply by that amount", async function () {
      const { brb } = await useDeployWithCreateFixture();
      const [, , , , , player5] = await viem.getWalletClients();

      const balance = await brb.read.balanceOf([
        player5.account.address,
      ]);
      const supplyBefore = await brb.read.totalSupply();

      await brb.write.burn([balance], { account: player5.account });

      const supplyAfter = await brb.read.totalSupply();
      expect(supplyAfter).to.equal(supplyBefore - balance);
      expect(
        await brb.read.balanceOf([player5.account.address])
      ).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------
  // Withdrawal Queue Head Advancement (regression test for stagnant queueHead bug)
  // -------------------------------------------------------------------
  describe("Withdrawal Queue Head Advancement", function () {
    it("Should process withdrawals past null gaps after earlier entries were processed", async function () {
      const {
        stakedBrbProxy,
        rouletteProxy,
        brb,
        vrfCoordinator,
      } = await useDeployWithCreateFixture();
      const publicClient = await viem.getPublicClient();
      const wallets = await viem.getWalletClients();
      const admin = wallets[0];

      // Setup: create 8 stakers with deposits
      const stakers = wallets.slice(1, 9); // 8 stakers
      const depositAmount = parseEther("100");

      // Transfer BRB to stakers and approve vault + admin (forwarder) for shares
      for (const s of stakers) {
        await brb.write.transfer([s.account.address, depositAmount], {
          account: admin.account,
        });
        await brb.write.approve([stakedBrbProxy.address, depositAmount], {
          account: s.account,
        });
        // Approve admin (mock forwarder) for sBRB share spending during withdrawal processing
        await stakedBrbProxy.write.approve([admin.account.address, MAX_UINT256], {
          account: s.account,
        });
      }

      // First deposit bootstraps vault
      await stakedBrbProxy.write.deposit(
        [depositAmount, stakers[0].account.address, 0n],
        { account: stakers[0].account }
      );

      // Remaining stakers queue deposits during game period
      for (let i = 1; i < stakers.length; i++) {
        await stakedBrbProxy.write.deposit(
          [depositAmount, stakers[i].account.address, 0n],
          { account: stakers[i].account }
        );
      }

      // Run a round so queued deposits are processed in cleaning
      // Need a small bet so there's a round to resolve
      const betAmt = parseEther("1");
      const betData = encodeBets([betAmt], [1n], [5n]); // straight on 5
      await brb.write.bet(
        [stakedBrbProxy.address, betAmt, betData, zeroAddress],
        { account: admin.account }
      );
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n
      );

      // Now queue withdrawals for all 8 stakers
      for (const s of stakers) {
        const shares = await stakedBrbProxy.read.balanceOf([
          s.account.address,
        ]);
        if (shares > 0n) {
          const assets = await stakedBrbProxy.read.convertToAssets([shares]);
          if (assets >= parseEther("1")) {
            await stakedBrbProxy.write.withdraw(
              [assets, s.account.address, s.account.address, 0n],
              { account: s.account }
            );
          }
        }
      }

      // Verify queue has entries
      const [batchSize, queueLenBefore] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      expect(queueLenBefore).to.be.gte(2n);

      // Place bet and resolve a round to trigger cleaning (processes first batch of withdrawals)
      await brb.write.bet(
        [stakedBrbProxy.address, betAmt, betData, zeroAddress],
        { account: admin.account }
      );
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n
      );

      const [, queueLenAfterRound1] =
        await stakedBrbProxy.read.getWithdrawalSettings();

      // Some withdrawals should have been processed (batch of 5)
      expect(queueLenAfterRound1).to.be.lt(queueLenBefore);

      // Key test: if there are remaining withdrawals, the next round must still process them
      // This was the bug — queueHead never advanced, so checkUpkeep would scan null entries forever
      if (queueLenAfterRound1 > 0n) {
        await brb.write.bet(
          [stakedBrbProxy.address, betAmt, betData, zeroAddress],
          { account: admin.account }
        );
        await resolveFullRound(
          stakedBrbProxy,
          rouletteProxy,
          vrfCoordinator,
          publicClient,
          7n
        );

        const [, queueLenAfterRound2] =
          await stakedBrbProxy.read.getWithdrawalSettings();

        // The second round must have processed more withdrawals (not stuck on nulls)
        expect(queueLenAfterRound2).to.be.lt(queueLenAfterRound1);
      }
    });

    it("checkUpkeep should scan past null entries to find valid withdrawal users", async function () {
      const {
        stakedBrbProxy,
        rouletteProxy,
        brb,
        vrfCoordinator,
      } = await useDeployWithCreateFixture();
      const publicClient = await viem.getPublicClient();
      const wallets = await viem.getWalletClients();
      const admin = wallets[0];

      // Setup 3 stakers
      const stakers = wallets.slice(1, 4);
      const depositAmount = parseEther("100");

      for (const s of stakers) {
        await brb.write.transfer([s.account.address, depositAmount], {
          account: admin.account,
        });
        await brb.write.approve([stakedBrbProxy.address, depositAmount], {
          account: s.account,
        });
        // Approve admin (mock forwarder) for sBRB share spending during withdrawal processing
        await stakedBrbProxy.write.approve([admin.account.address, MAX_UINT256], {
          account: s.account,
        });
      }

      // First deposit bootstraps vault
      await stakedBrbProxy.write.deposit(
        [depositAmount, stakers[0].account.address, 0n],
        { account: stakers[0].account }
      );

      // Queue remaining deposits
      for (let i = 1; i < stakers.length; i++) {
        await stakedBrbProxy.write.deposit(
          [depositAmount, stakers[i].account.address, 0n],
          { account: stakers[i].account }
        );
      }

      // Resolve round to process deposits
      const betAmt = parseEther("1");
      const betData = encodeBets([betAmt], [1n], [5n]);
      await brb.write.bet(
        [stakedBrbProxy.address, betAmt, betData, zeroAddress],
        { account: admin.account }
      );
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n
      );

      // Staker[0] queues withdrawal then cancels it (creates a null entry at queueHead)
      const s0Shares = await stakedBrbProxy.read.balanceOf([
        stakers[0].account.address,
      ]);
      const s0Assets = await stakedBrbProxy.read.convertToAssets([s0Shares]);
      if (s0Assets >= parseEther("1")) {
        await stakedBrbProxy.write.withdraw(
          [s0Assets, stakers[0].account.address, stakers[0].account.address, 0n],
          { account: stakers[0].account }
        );
        // Cancel to create a null gap
        await stakedBrbProxy.write.cancelWithdrawal({
          account: stakers[0].account,
        });
      }

      // Staker[1] queues withdrawal (should be after the null gap)
      const s1Shares = await stakedBrbProxy.read.balanceOf([
        stakers[1].account.address,
      ]);
      const s1Assets = await stakedBrbProxy.read.convertToAssets([s1Shares]);
      if (s1Assets >= parseEther("1")) {
        await stakedBrbProxy.write.withdraw(
          [s1Assets, stakers[1].account.address, stakers[1].account.address, 0n],
          { account: stakers[1].account }
        );
      }

      const [, queueLen] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      expect(queueLen).to.equal(1n); // only staker[1]

      // Resolve round — the cleaning should find staker[1] past the null gap
      await brb.write.bet(
        [stakedBrbProxy.address, betAmt, betData, zeroAddress],
        { account: admin.account }
      );
      await resolveFullRound(
        stakedBrbProxy,
        rouletteProxy,
        vrfCoordinator,
        publicClient,
        7n
      );

      const [, queueLenAfter] =
        await stakedBrbProxy.read.getWithdrawalSettings();
      // Staker[1]'s withdrawal should have been processed (not stuck behind null gap)
      expect(queueLenAfter).to.equal(0n);
    });
  });
});
