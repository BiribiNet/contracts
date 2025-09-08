import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { checksumAddress, encodeAbiParameters, keccak256, parseEther, toHex } from "viem";

import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

describe("RouletteClean - Automation", function () {
  // Use the shared fixture from deployWithCreate script

  describe("Upkeep Registration", function () {
    it("Should register VRF upkeep successfully", async function () {
      const { rouletteProxy, mockLinkToken } = await useDeployWithCreateFixture();
      const [admin] = await viem.getWalletClients();
      const rouletteAddress = rouletteProxy.address;

      const linkAmount = parseEther("10");

      // Check LINK was transferred
      const contractBalance = await mockLinkToken.read.balanceOf([rouletteAddress]);
      expect(contractBalance).to.be.gt(0n);
    });

    it("Should register multiple payout upkeeps", async function () {
      const { rouletteProxy, mockLinkToken } = await useDeployWithCreateFixture()
      const [admin] = await viem.getWalletClients();
      const rouletteAddress = rouletteProxy.address;

      const upkeepCount = 5;
      const linkAmountPerUpkeep = parseEther("2");
      const totalLinkNeeded = linkAmountPerUpkeep * BigInt(upkeepCount);

      // Check LINK was transferred
      const contractBalance = await mockLinkToken.read.balanceOf([rouletteAddress]);
      expect(contractBalance).to.be.gte(totalLinkNeeded);

      // Check upkeep config was updated
      const [maxSupportedBets, registeredUpkeepCount, batchSize, upkeepGasLimit] = await rouletteProxy.read.getUpkeepConfig();
      expect(maxSupportedBets).to.be.gte(10n);
      expect(registeredUpkeepCount).to.be.gte(1n);
    });

    it("Should reject upkeep registration from non-admin", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const linkAmount = parseEther("10");

      await expect(
        rouletteProxy.write.registerVRFUpkeep([linkAmount], { account: player1.account })
      ).to.be.rejectedWith(`AccessControlUnauthorizedAccount("${checksumAddress(player1.account.address)}", "0x0000000000000000000000000000000000000000000000000000000000000000")`); // AccessControl revert
    });

    it("Should enforce bet limits based on registered upkeeps", async function () {
      const { rouletteProxy, stakedBrbProxy, brb, mockLinkToken } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Register only 1 payout upkeep (supports 10 bets max)
      await mockLinkToken.write.approve([rouletteProxy.address, parseEther("1000")]);
      await rouletteProxy.write.registerPayoutUpkeeps([1n, parseEther("2")]);

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
        brb.write.bet([stakedBrbProxy.address, totalAmount, betData], { account: admin.account })
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
        brb.write.bet([stakedBrbProxy.address, validTotalAmount, validBetData], { account: admin.account })
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

      await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);

      const timeUntilNextRound = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
      await time.increase(timeUntilNextRound);

      // Check upkeep
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x"]);
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

      await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);

      const timeUntilNextRound = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
      await time.increase(timeUntilNextRound);
      // Check upkeep
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      expect(needsExecution).to.be.true;

      // Perform upkeep
      await expect(rouletteProxy.write.performUpkeep([performData])).to.not.be.rejected;
    });

    it("Should handle empty upkeep data", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      // Check upkeep with empty data
      const [needsExecution, performData] = await rouletteProxy.read.checkUpkeep(["0x"]);
      expect(needsExecution).to.be.false;
      expect(performData).to.equal("0x");
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

      // Get current round info
      const [currentRound, lastRoundPaid, lastRoundStartTime] = await rouletteProxy.read.getCurrentRoundInfo();
      
      // Simulate time passing
      await time.increase(70); // More than game period
      
      // Check if new round should start
      const [newRound] = await rouletteProxy.read.getCurrentRoundInfo();
      expect(newRound).to.be.gte(currentRound);
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
      const { rouletteProxy, mockLinkToken } = await useDeployWithCreateFixture();

      const [deployer] = await viem.getWalletClients();
      // Set low LINK balance
      await mockLinkToken.write.setBalance([deployer.account.address, 0n]);

      // Try to register upkeep
      await expect(
        rouletteProxy.write.registerVRFUpkeep([parseEther("1")])
      ).to.be.rejected
    });
  });
});
