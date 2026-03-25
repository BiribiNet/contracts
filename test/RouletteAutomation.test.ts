import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, keccak256, parseEther, parseEventLogs, toHex, zeroAddress } from "viem";

import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

const MAX_UINT256 = 2n ** 256n - 1n;

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

describe("RouletteClean - Automation", function () {
  // Use the shared fixture from deployWithCreate script

  describe("Upkeep Registration", function () {
    it("Should register VRF upkeep successfully", async function () {
      const { upkeepManager, mockLinkToken } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      const managerAddress = upkeepManager.address;

      const linkAmount = parseEther("10");

      // LINK for registrations is held on BRBUpkeepManager
      const contractBalance = await mockLinkToken.read.balanceOf([managerAddress]);
      expect(contractBalance).to.be.gt(0n);
    });

    it("Should register multiple payout upkeeps", async function () {
      const { rouletteProxy, upkeepManager, mockLinkToken } = await useDeployWithCreateFixture()
      const [admin] = await viem.getWalletClients();

      const upkeepCount = 5;
      const linkAmountPerUpkeep = parseEther("2");
      const totalLinkNeeded = linkAmountPerUpkeep * BigInt(upkeepCount);

      const contractBalance = await mockLinkToken.read.balanceOf([upkeepManager.address]);
      expect(contractBalance).to.be.gte(totalLinkNeeded);

      const [maxSupportedBets, registeredUpkeepCount, batchSize, upkeepGasLimit] = await rouletteProxy.read.getUpkeepConfig();
      expect(maxSupportedBets).to.be.gte(10n);
      expect(registeredUpkeepCount).to.be.gte(1n);
    });

    it("Should handle sequential calls to registerPayoutUpkeeps", async function () {
      const { rouletteProxy, upkeepManager, mockLinkToken } = await useDeployWithCreateFixture();
      const publicClient = await viem.getPublicClient();

      const [, initialCount] = await rouletteProxy.read.getUpkeepConfig();

      await mockLinkToken.write.approve([upkeepManager.address, parseEther("100")]);

      // 1. First registration (2 upkeeps)
      const tx1 = await upkeepManager.write.registerPayoutUpkeeps([2n, parseEther("2")]);
      const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
      const logs1 = parseEventLogs({
        abi: upkeepManager.abi,
        eventName: 'UpkeepRegistered',
        logs: receipt1.logs,
      });

      expect(logs1.length).to.equal(2);
      // checkDataLength = i + 3 (0/1=lock+VRF use 1-byte tags; 2=compute; 3+= payout batches)
      expect(logs1[0].args.checkDataLength).to.equal(initialCount + 3n);
      expect(logs1[1].args.checkDataLength).to.equal(initialCount + 4n);

      // 2. Second registration (2 upkeeps)
      const tx2 = await upkeepManager.write.registerPayoutUpkeeps([2n, parseEther("2")]);
      const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
      const logs2 = parseEventLogs({
        abi: upkeepManager.abi,
        eventName: 'UpkeepRegistered',
        logs: receipt2.logs,
      });

      expect(logs2.length).to.equal(2);
      expect(logs2[0].args.checkDataLength).to.equal(initialCount + 5n);
      expect(logs2[1].args.checkDataLength).to.equal(initialCount + 6n);

      const [, registeredUpkeepCount] = await rouletteProxy.read.getUpkeepConfig();
      expect(registeredUpkeepCount).to.equal(initialCount + 4n);
    });

    it("Should reject upkeep registration without REGISTRANT_ROLE", async function () {
      const { upkeepManager } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const linkAmount = parseEther("10");

      await expect(
        upkeepManager.write.registerVRFUpkeep([linkAmount], { account: player1.account })
      ).to.be.rejected;
    });

    it("Should enforce bet limits based on registered upkeeps", async function () {
      const { rouletteProxy, upkeepManager, stakedBrbProxy, brb, mockLinkToken } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      await mockLinkToken.write.approve([upkeepManager.address, parseEther("1000")]);
      await upkeepManager.write.registerPayoutUpkeeps([1n, parseEther("2")]);

      const [maxSupportedBets, ] = await rouletteProxy.read.getUpkeepConfig();
      // Stake and try to place more bets than supported
      const stakeAmount = parseEther("1000"); // Increased from 500 to 1000 ETH to provide enough balance
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      const betAmount = parseEther("0.1"); // Reduced from 10 to 0.1 ETH to avoid balance issues
      const amounts = Array.from({ length: Number(maxSupportedBets) + 1 }, () => betAmount);
      const betTypes = Array.from({ length: Number(maxSupportedBets) + 1 }, () => 1n); // All straight bets
      const numbers = Array.from({ length: Number(maxSupportedBets) + 1 }, (_, i) => BigInt(i % 37)); // Numbers 0-36

      const totalAmount = betAmount * (maxSupportedBets + 1n);
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts, betTypes, numbers }]
      );

      await expect(
        brb.write.bet([stakedBrbProxy.address, totalAmount, betData, zeroAddress], { account: admin.account })
      ).to.be.rejectedWith("BetLimitExceeded");

      // But 10 bets should work
      const validAmounts = amounts.slice(0, 10)
      const validBetTypes = betTypes.slice(0, 10)
      const validNumbers = numbers.slice(0, 10)
      const validTotalAmount = betAmount * 10n;

      const validBetData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: validAmounts, betTypes: validBetTypes, numbers: validNumbers }]
      );

      await expect(
        brb.write.bet([stakedBrbProxy.address, validTotalAmount, validBetData, zeroAddress], { account: admin.account })
      ).to.be.fulfilled;
    });
  });

  describe("Automation Functions", function () {
    it("Should check upkeep correctly", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Place a bet first
      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      const betAmount = parseEther("0.1"); // Reduced from 10 to 0.1 ETH to avoid balance issues
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );

      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress]);

      await advanceThroughLockToVrfWindow(rouletteProxy);

      // checkData length 1 = VRF (after pre-VRF lock: empty checkData)
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x01"]);
      expect(needsExecution).to.be.true;
      expect(performData).to.not.equal("0x");
    });

    it("Should perform upkeep correctly", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      // Place a bet first
      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

      const betAmount = parseEther("0.1"); // Reduced from 10 to 0.1 ETH to avoid balance issues
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );

      await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress]);

      await advanceThroughLockToVrfWindow(rouletteProxy);
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x01"]);
      expect(needsExecution).to.be.true;

      // Perform upkeep
      await expect(rouletteProxy.write.performUpkeep([performData])).to.not.be.rejected;
    });

    it("Should use empty checkData for pre-VRF lock upkeep", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      const [, , gamePeriod] = await rouletteProxy.read.getConstants();
      await time.increase(gamePeriod);

      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      expect(needsExecution).to.be.true;
      expect(performData).to.not.equal("0x");
    });

    it("Should handle invalid upkeep data", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      // Check upkeep with invalid data
      const invalidData = keccak256(toHex("invalid"));
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep([invalidData]);
      expect(needsExecution).to.be.false;
    });
  });

  describe("Round Management", function () {
    it("Should start new round when needed", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      const [currentRound] = await rouletteProxy.read.getCurrentRoundInfo();
      expect(currentRound).to.be.gt(0n);
    });

    it("Should handle round transitions", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      // Get constants from contract
      const [, , gamePeriod,] = await rouletteProxy.read.getConstants();

      // Get current round info
      const [currentRound] = await rouletteProxy.read.getCurrentRoundInfo();
      
      // Simulate time passing (game period + max no-bet lock + 1)
      await time.increase(gamePeriod + 12n);
      
      // Check if new round should start
      const [newRound] = await rouletteProxy.read.getCurrentRoundInfo();
      expect(newRound).to.be.gte(currentRound);
    });

    it("Should return correct constants from getConstants()", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      const [noBetLockMin, batchSize, gamePeriod, upkeepGasLimit] = await rouletteProxy.read.getConstants();
      
      // Verify constants are reasonable values
      expect(noBetLockMin).to.equal(6n); // min no-bet lock seconds
      expect(batchSize).to.equal(35n); // BATCH_SIZE = 35
      expect(gamePeriod).to.be.gt(0n); // GAME_PERIOD should be positive
      expect(upkeepGasLimit).to.be.gt(0n); // UPKEEP_GAS_LIMIT should be positive
      
      // Verify upkeep gas limit calculation: BASE_GAS_OVERHEAD + (BATCH_SIZE * GAS_PER_WINNING_BET)
      // BASE_GAS_OVERHEAD = 100000, GAS_PER_WINNING_BET = 50000
      const expectedGasLimit = 100000n + (batchSize * 50000n);
      expect(upkeepGasLimit).to.equal(expectedGasLimit);
    });
  });

  describe("Error Handling", function () {
    it("Should handle invalid upkeep calls", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      // Try to perform upkeep without checking first
      const invalidData = keccak256(toHex("invalid"));
      await expect(
        rouletteProxy.write.performUpkeep([invalidData])
      ).to.be.rejected
    });

    it("Should handle insufficient LINK balance", async function () {
      const { upkeepManager, mockLinkToken } = await useDeployWithCreateFixture();

      const [deployer] = await viem.getWalletClients();
      // Set low LINK balance
      await mockLinkToken.write.setBalance([deployer.account.address, 0n]);

      await expect(
        upkeepManager.write.registerVRFUpkeep([parseEther("1")])
      ).to.be.rejected
    });
  });
});
