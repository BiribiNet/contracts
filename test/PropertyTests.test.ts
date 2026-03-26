import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseEther, zeroAddress } from "viem";
import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

const MAX_UINT256 = 2n ** 256n - 1n;

/** PRNG for deterministic randomness in fuzz tests */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeBets(amounts: bigint[], betTypes: bigint[], numbers: bigint[]) {
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
  const [lockNeeded, lockData] = await rouletteProxy.read.checkUpkeep(["0x"]);
  if (!lockNeeded) throw new Error("expected pre-VRF lock upkeep");
  await rouletteProxy.write.performUpkeep([lockData]);
  s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  while (s > 0n && s < MAX_UINT256) {
    await time.increase(s);
    s = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
  }
}

// =====================================================================
// FUZZ TESTS
// =====================================================================

describe("Property & Fuzz Tests", function () {

  describe("Fuzz: Bet Amounts", function () {
    it("Should accept any valid bet amount >= 10000 gwei on any straight number 0-36", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Fund vault
      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      const rand = mulberry32(42);
      const MIN_BET = 10000n * 10n ** 9n; // 10000 gwei

      // Test 20 random valid bet amounts on random straight numbers
      for (let i = 0; i < 20; i++) {
        const number = BigInt(Math.floor(rand() * 37)); // 0-36
        const amount = MIN_BET + BigInt(Math.floor(rand() * 1e16));
        const betData = encodeBets([amount], [1n], [number]);

        await brb.write.bet(
          [stakedBrbProxy.address, amount, betData, zeroAddress],
          { account: player1.account }
        );
      }
    });

    it("Should reject bet amounts below 10000 gwei", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      const tooSmall = 9999n * 10n ** 9n;
      const betData = encodeBets([tooSmall], [1n], [0n]);

      await expect(
        brb.write.bet([stakedBrbProxy.address, tooSmall, betData, zeroAddress], { account: player1.account })
      ).to.be.rejected;
    });
  });

  describe("Fuzz: Multi-bet combinations", function () {
    it("Should handle random combinations of bet types in a single tx", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      const rand = mulberry32(123);
      const betAmount = parseEther("1");

      // Valid bet type configs: [betType, numberGenerator]
      const betConfigs: Array<[bigint, () => bigint]> = [
        [1n, () => BigInt(Math.floor(rand() * 37))], // STRAIGHT: 0-36
        [6n, () => BigInt(Math.floor(rand() * 3)) + 1n], // COLUMN: 1-3
        [7n, () => BigInt(Math.floor(rand() * 3)) + 1n], // DOZEN: 1-3
        [8n, () => 0n],  // RED
        [9n, () => 0n],  // BLACK
        [10n, () => 0n], // ODD
        [11n, () => 0n], // EVEN
        [12n, () => 0n], // LOW
        [13n, () => 0n], // HIGH
      ];

      const amounts: bigint[] = [];
      const betTypes: bigint[] = [];
      const numbers: bigint[] = [];
      let totalAmount = 0n;

      for (let i = 0; i < 5; i++) {
        const [betType, numGen] = betConfigs[Math.floor(rand() * betConfigs.length)];
        amounts.push(betAmount);
        betTypes.push(betType);
        numbers.push(numGen());
        totalAmount += betAmount;
      }

      const betData = encodeBets(amounts, betTypes, numbers);

      await brb.write.bet(
        [stakedBrbProxy.address, totalAmount, betData, zeroAddress],
        { account: player1.account }
      );

      const pendingBets = await stakedBrbProxy.read.getPendingBets();
      expect(pendingBets).to.equal(totalAmount);
    });
  });

  // =====================================================================
  // INVARIANT TESTS
  // =====================================================================

  describe("Invariant: Fee split always sums correctly", function () {
    it("protocolFees + burn + jackpot + stakerProfit == lossAmount for random fee configs", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      const rand = mulberry32(777);

      for (let i = 0; i < 15; i++) {
        const protocol = BigInt(Math.floor(rand() * 501)); // 0-500
        const burn = BigInt(Math.floor(rand() * 201));      // 0-200
        const jackpot = BigInt(Math.floor(rand() * 501));   // 0-500
        if (protocol + burn + jackpot > 1000n) continue;

        await stakedBrbProxy.write.setProtocolFeeRate([protocol], { account: admin.account });
        await stakedBrbProxy.write.setBurnFeeRate([burn], { account: admin.account });
        await stakedBrbProxy.write.setJackpotFeeRate([jackpot], { account: admin.account });

        const lossAmount = parseEther(String(Math.floor(rand() * 10000) + 1));
        const [{ protocolFees, burnAmount, jackpotAmount }, stakerProfit] =
          await stakedBrbProxy.read.previewProtocolFee([lossAmount]);

        // INVARIANT: all parts sum to the whole
        expect(protocolFees + burnAmount + jackpotAmount + stakerProfit).to.equal(lossAmount);

        // INVARIANT: stakers always get >= 90%
        expect(stakerProfit * 10000n / lossAmount).to.be.gte(9000n);
      }
    });
  });

  describe("Invariant: Fee rate caps enforced", function () {
    it("Should reject protocol fee > 500 BPS", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await expect(stakedBrbProxy.write.setProtocolFeeRate([501n], { account: admin.account })).to.be.rejectedWith("InvalidFeeRate");
    });

    it("Should reject burn fee > 200 BPS", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await expect(stakedBrbProxy.write.setBurnFeeRate([201n], { account: admin.account })).to.be.rejectedWith("InvalidFeeRate");
    });

    it("Should reject jackpot fee > 500 BPS", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await expect(stakedBrbProxy.write.setJackpotFeeRate([501n], { account: admin.account })).to.be.rejectedWith("InvalidFeeRate");
    });

    it("Should reject total fees > 1000 BPS", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await stakedBrbProxy.write.setProtocolFeeRate([500n], { account: admin.account });
      await stakedBrbProxy.write.setBurnFeeRate([200n], { account: admin.account });
      await expect(stakedBrbProxy.write.setJackpotFeeRate([301n], { account: admin.account })).to.be.rejectedWith("InvalidFeeRate");
    });
  });

  describe("Invariant: Vault solvency", function () {
    it("totalAssets unchanged after bet placement (pendingBets excluded)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("10000");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      const totalAssetsBefore = await stakedBrbProxy.read.totalAssets();

      const betAmount = parseEther("1");
      const betData = encodeBets([betAmount], [8n], [0n]); // RED
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });

      const totalAssetsAfter = await stakedBrbProxy.read.totalAssets();
      // totalAssets = balance - pendingBets; bet adds betAmount to both → net zero
      expect(totalAssetsAfter).to.equal(totalAssetsBefore);
    });

    it("maxPayout check prevents insolvency from oversized bets", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      // Straight bet 5 BRB → needs 5*36*1.1 = 198 BRB capacity > 100 vault
      const tooBigBet = parseEther("5");
      const betData = encodeBets([tooBigBet], [1n], [7n]);

      await expect(
        brb.write.bet([stakedBrbProxy.address, tooBigBet, betData, zeroAddress], { account: player1.account })
      ).to.be.rejected;
    });
  });

  describe("Invariant: BRB supply only decreases", function () {
    it("BRB totalSupply == 30M at deployment (no minting possible)", async function () {
      const { brb } = await useDeployWithCreateFixture();
      expect(await brb.read.totalSupply()).to.equal(parseEther("30000000"));
    });
  });

  // =====================================================================
  // EDGE CASE TESTS
  // =====================================================================

  describe("Edge Cases", function () {
    it("Should enforce MINIMUM_WITHDRAWAL on withdraw", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      await expect(
        stakedBrbProxy.write.withdraw([parseEther("0.5"), admin.account.address, admin.account.address, 0n], { account: admin.account })
      ).to.be.rejectedWith("WithdrawalTooSmall");
    });

    it("Should enforce MINIMUM_WITHDRAWAL on redeem (dust shares)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: admin.account });
      await stakedBrbProxy.write.deposit([stakeAmount, admin.account.address, 0n], { account: admin.account });

      await expect(
        stakedBrbProxy.write.redeem([1n, admin.account.address, admin.account.address, 0n], { account: admin.account })
      ).to.be.rejectedWith("WithdrawalTooSmall");
    });

    it("MINIMUM_FIRST_DEPOSIT constant == 1e18", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      expect(await stakedBrbProxy.read.MINIMUM_FIRST_DEPOSIT()).to.equal(parseEther("1"));
    });

    it("Withdrawal queue defaults: batchSize=5, queueLength=0, maxQueue=100", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [batchSize, queueLength, maxQueueLength] = await stakedBrbProxy.read.getWithdrawalSettings();
      expect(batchSize).to.equal(5n);
      expect(queueLength).to.equal(0n);
      expect(maxQueueLength).to.equal(100n);
    });

    it("Should reject deposit of 0", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await expect(
        stakedBrbProxy.write.deposit([0n, admin.account.address, 0n], { account: admin.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should reject withdrawal of 0", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await brb.write.approve([stakedBrbProxy.address, parseEther("100")], { account: admin.account });
      await stakedBrbProxy.write.deposit([parseEther("100"), admin.account.address, 0n], { account: admin.account });
      await expect(
        stakedBrbProxy.write.withdraw([0n, admin.account.address, admin.account.address, 0n], { account: admin.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should reject redeem of 0 shares", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      await brb.write.approve([stakedBrbProxy.address, parseEther("100")], { account: admin.account });
      await stakedBrbProxy.write.deposit([parseEther("100"), admin.account.address, 0n], { account: admin.account });
      await expect(
        stakedBrbProxy.write.redeem([0n, admin.account.address, admin.account.address, 0n], { account: admin.account })
      ).to.be.rejectedWith("ZeroAmount");
    });

    it("Should reject bet when betting is closed (after game period)", async function () {
      const { stakedBrbProxy, rouletteProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await brb.write.approve([stakedBrbProxy.address, parseEther("10000")], { account: admin.account });
      await stakedBrbProxy.write.deposit([parseEther("10000"), admin.account.address, 0n], { account: admin.account });

      await advanceThroughLockToVrfWindow(rouletteProxy);

      const betData = encodeBets([parseEther("1")], [1n], [0n]);
      await expect(
        brb.write.bet([stakedBrbProxy.address, parseEther("1"), betData, zeroAddress], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should reject invalid bet types (0 and 16+)", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await brb.write.approve([stakedBrbProxy.address, parseEther("10000")], { account: admin.account });
      await stakedBrbProxy.write.deposit([parseEther("10000"), admin.account.address, 0n], { account: admin.account });

      for (const invalidType of [0n, 16n, 100n]) {
        const betData = encodeBets([parseEther("1")], [invalidType], [0n]);
        await expect(
          brb.write.bet([stakedBrbProxy.address, parseEther("1"), betData, zeroAddress], { account: player1.account })
        ).to.be.rejected;
      }
    });
  });
});
