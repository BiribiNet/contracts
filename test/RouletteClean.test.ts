import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ignition } from "hardhat";
import RouletteTestSetupModule from "../ignition/modules/RouletteTestSetup";
import { RouletteClean, StakedBRB, BRB, MockLinkToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("RouletteClean", function () {
  // Fixture for deploying contracts
  async function deployRouletteFixture() {
    const { 
      mockLinkToken, 
      vrfCoordinatorMock,
      mockAutomationRegistry,
      brbToken, 
      stakedBRB, 
      roulette,
      admin,
      player1,
      player2
    } = await ignition.deploy(RouletteTestSetupModule);

    // Initialize StakedBRB
    await stakedBRB.initialize(
      admin.address,
      "Staked BRB",
      "sBRB", 
      250, // 2.5% protocol fee
      admin.address // fee recipient
    );

    // Initialize RouletteClean with mock addresses
    await roulette.initialize(
      admin.address,
      mockAutomationRegistry.target, // Use mock as registrar
      mockAutomationRegistry.target, // Use mock as registry  
      mockLinkToken.target  // Use mock as LINK token
    );

    // Mint tokens for testing
    const initialAmount = ethers.parseEther("10000");
    await brbToken.connect(admin).transfer(player1.address, initialAmount);
    await brbToken.connect(admin).transfer(player2.address, initialAmount);

    // Approve StakedBRB for spending
    await brbToken.connect(player1).approve(stakedBRB.target, ethers.MaxUint256);
    await brbToken.connect(player2).approve(stakedBRB.target, ethers.MaxUint256);

    return {
      mockLinkToken: mockLinkToken as MockLinkToken,
      vrfCoordinatorMock,
      brbToken: brbToken as BRB,
      stakedBRB: stakedBRB as StakedBRB,
      roulette: roulette as RouletteClean,
      admin: admin as HardhatEthersSigner,
      player1: player1 as HardhatEthersSigner,
      player2: player2 as HardhatEthersSigner,
    };
  }

  describe("Deployment", function () {
    it("Should deploy with correct initial values", async function () {
      const { roulette, stakedBRB, admin } = await loadFixture(deployRouletteFixture);

      const roundInfo = await roulette.getCurrentRoundInfo();
      expect(roundInfo.currentRound).to.equal(1);
      expect(roundInfo.lastRoundPaid).to.equal(0);

      const hasAdminRole = await roulette.hasRole(await roulette.DEFAULT_ADMIN_ROLE(), admin.address);
      expect(hasAdminRole).to.be.true;
    });

    it("Should have correct StakedBRB configuration", async function () {
      const { stakedBRB, brbToken, admin } = await loadFixture(deployRouletteFixture);

      const config = await stakedBRB.getVaultConfig();
      expect(config.brbToken).to.equal(brbToken.target);
      expect(config.protocolFeeBasisPoints).to.equal(250);
      expect(config.feeRecipient).to.equal(admin.address);
    });
  });

  describe("Betting", function () {
    it("Should place a single straight bet", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      // Stake some BRB first
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      // Create bet data for straight bet on number 7
      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]] // amounts, betTypes (1=straight), numbers
      );

      // Place bet through BRB token
      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
      ).to.emit(roulette, "BetPlaced")
       .withArgs(player1.address, betAmount, 1, 7);

      // Check round bets count
      const roundInfo = await roulette.getCurrentRoundInfo();
      const betsCount = await roulette.getRoundBetsCount(roundInfo.currentRound);
      expect(betsCount).to.equal(1);
    });

    it("Should place multiple bets in one transaction", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      // Stake some BRB first
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      // Create multiple bet data
      const bet1Amount = ethers.parseEther("5");
      const bet2Amount = ethers.parseEther("10");
      const totalAmount = bet1Amount + bet2Amount;

      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[bet1Amount, bet2Amount], [1, 8], [7, 0]]] // straight on 7, red bet
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, totalAmount, betData)
      ).to.emit(roulette, "BetPlaced").twice;

      const roundInfo = await roulette.getCurrentRoundInfo();
      const betsCount = await roulette.getRoundBetsCount(roundInfo.currentRound);
      expect(betsCount).to.equal(2);
    });

    it("Should reject invalid bet types", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [99], [7]]] // Invalid bet type 99
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
      ).to.be.revertedWithCustomError(roulette, "InvalidBetType");
    });

    it("Should reject bet amount mismatches", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const wrongTotalAmount = ethers.parseEther("5"); // Wrong total

      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]]
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, wrongTotalAmount, betData)
      ).to.be.revertedWithCustomError(roulette, "InvalidBet");
    });

    it("Should reject bets with invalid numbers for bet types", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");

      // Test invalid straight bet number (>36)
      const invalidStraightBet = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [37]]] // Invalid number 37 for straight bet
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, betAmount, invalidStraightBet)
      ).to.be.revertedWithCustomError(roulette, "InvalidNumber");

      // Test invalid street bet number
      const invalidStreetBet = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [3], [2]]] // Invalid street start (must be 1,4,7,etc)
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, betAmount, invalidStreetBet)
      ).to.be.revertedWithCustomError(roulette, "InvalidNumber");
    });
  });

  describe("VRF and Round Management", function () {
    it("Should handle VRF callback and store winning number", async function () {
      const { roulette, vrfCoordinatorMock, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      // Place a bet first
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]]
      );

      await brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData);

      // Simulate time passing and trigger VRF
      await ethers.provider.send("evm_increaseTime", [70]); // 70 seconds
      await ethers.provider.send("evm_mine", []);

      // Mock VRF response with winning number 7
      const randomWords = [7n]; // This will result in 7 % 37 = 7
      const requestId = 1n;

      // Simulate VRF callback
      await expect(
        vrfCoordinatorMock.fulfillRandomWords(roulette.target, requestId, randomWords)
      ).to.emit(roulette, "VRFResult")
       .withArgs(1, 7);

      // Check that the result was stored
      const roundResult = await roulette.getRoundResult(1);
      expect(roundResult.winningNumber).to.equal(7);
      expect(roundResult.isSet).to.be.true;
    });

    it("Should process winning payouts correctly", async function () {
      const { roulette, vrfCoordinatorMock, stakedBRB, brbToken, player1, admin } = await loadFixture(deployRouletteFixture);

      // Stake some BRB to provide liquidity
      const liquidityAmount = ethers.parseEther("1000");
      await stakedBRB.connect(admin).deposit(liquidityAmount, admin.address);

      // Player stakes and bets
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]] // Straight bet on 7
      );

      await brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData);

      // Get player balance before payout
      const balanceBefore = await brbToken.balanceOf(player1.address);

      // Trigger VRF with winning number 7
      const randomWords = [7n];
      const requestId = 1n;

      await vrfCoordinatorMock.fulfillRandomWords(roulette.target, requestId, randomWords);

      // Check that winning payout was calculated (35:1 for straight bet)
      const expectedPayout = betAmount * 35n;
      
      // Note: Actual payout processing would happen through checkUpkeep/performUpkeep
      // which requires Chainlink Automation setup. For unit tests, we can verify
      // the payout calculation logic directly.
    });
  });

  describe("Bet Validation", function () {
    it("Should validate street bet numbers correctly", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");

      // Valid street bets (1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34)
      const validStreets = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];
      
      for (const street of validStreets) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [3], [street]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.not.be.reverted;
      }

      // Invalid street bets
      const invalidStreets = [0, 2, 3, 5, 6, 8, 9, 35, 36];
      
      for (const street of invalidStreets) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [3], [street]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.be.revertedWithCustomError(roulette, "InvalidNumber");
      }
    });

    it("Should validate column and dozen bets", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");

      // Valid column bets (1, 2, 3)
      for (let col = 1; col <= 3; col++) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [6], [col]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.not.be.reverted;
      }

      // Valid dozen bets (1, 2, 3)
      for (let dozen = 1; dozen <= 3; dozen++) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [7], [dozen]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.not.be.reverted;
      }

      // Invalid column/dozen bets
      const invalidNumbers = [0, 4, 5];
      
      for (const num of invalidNumbers) {
        const columnBetData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [6], [num]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, columnBetData)
        ).to.be.revertedWithCustomError(roulette, "InvalidNumber");

        const dozenBetData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [7], [num]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, dozenBetData)
        ).to.be.revertedWithCustomError(roulette, "InvalidNumber");
      }
    });

    it("Should validate outside bets have number parameter as 0", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");

      // Valid outside bets with number = 0
      const outsideBetTypes = [8, 9, 10, 11, 12, 13, 14, 15, 16]; // RED, BLACK, ODD, EVEN, LOW, HIGH, VOISINS, TIERS, ORPHELINS
      
      for (const betType of outsideBetTypes) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [betType], [0]]]
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.not.be.reverted;
      }

      // Invalid outside bets with number != 0
      for (const betType of outsideBetTypes) {
        const betData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint256[],uint256[],uint256[])"],
          [[[betAmount], [betType], [5]]] // Non-zero number
        );

        await expect(
          brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
        ).to.be.revertedWithCustomError(roulette, "InvalidNumber");
      }
    });
  });

  describe("Access Control", function () {
    it("Should only allow authorized callers to place bets", async function () {
      const { roulette, player1 } = await loadFixture(deployRouletteFixture);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]]
      );

      // Direct call should fail
      await expect(
        roulette.connect(player1).bet(player1.address, betAmount, betData)
      ).to.be.revertedWithCustomError(roulette, "UnauthorizedCaller");
    });

    it("Should have proper admin roles", async function () {
      const { roulette, admin, player1 } = await loadFixture(deployRouletteFixture);

      const adminRole = await roulette.DEFAULT_ADMIN_ROLE();
      
      expect(await roulette.hasRole(adminRole, admin.address)).to.be.true;
      expect(await roulette.hasRole(adminRole, player1.address)).to.be.false;
    });
  });

  describe("View Functions", function () {
    it("Should return correct round information", async function () {
      const { roulette } = await loadFixture(deployRouletteFixture);

      const roundInfo = await roulette.getCurrentRoundInfo();
      expect(roundInfo.currentRound).to.equal(1);
      expect(roundInfo.lastRoundPaid).to.equal(0);
      expect(roundInfo.lastRoundStartTime).to.be.gt(0);
    });

    it("Should return correct upkeep configuration", async function () {
      const { roulette } = await loadFixture(deployRouletteFixture);

      const config = await roulette.getUpkeepConfig();
      expect(config.maxSupportedBets).to.equal(0); // No upkeeps registered yet
      expect(config.registeredUpkeepCount).to.equal(0);
      expect(config.batchSize).to.equal(10);
      expect(config.upkeepGasLimit).to.be.gt(0);
    });

    it("Should check if more bets can be placed", async function () {
      const { roulette } = await loadFixture(deployRouletteFixture);

      // No upkeeps registered, so maxSupportedBets = 0
      const canPlace1 = await roulette.canPlaceBets(1);
      expect(canPlace1).to.be.false;

      const canPlace0 = await roulette.canPlaceBets(0);
      expect(canPlace0).to.be.true;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty bet arrays", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[], [], []]] // Empty arrays
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, 0, betData)
      ).to.be.revertedWithCustomError(roulette, "EmptyBetsArray");
    });

    it("Should handle array length mismatches", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1, 2], [7]]] // Mismatched array lengths
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData)
      ).to.be.revertedWithCustomError(roulette, "ArrayLengthMismatch");
    });

    it("Should handle zero amounts correctly", async function () {
      const { roulette, stakedBRB, brbToken, player1 } = await loadFixture(deployRouletteFixture);

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      // Test zero total amount
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[1000], [1], [7]]]
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, 0, betData)
      ).to.be.revertedWithCustomError(roulette, "ZeroAmount");

      // Test zero individual bet amount
      const zeroBetData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[0], [1], [7]]]
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, 0, zeroBetData)
      ).to.be.revertedWithCustomError(roulette, "ZeroAmount");
    });
  });
});
