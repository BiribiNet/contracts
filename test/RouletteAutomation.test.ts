import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ignition } from "hardhat";
import RouletteTestSetupModule from "../ignition/modules/RouletteTestSetup";
import { RouletteClean, StakedBRB, BRB, MockLinkToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("RouletteClean - Automation", function () {
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

    // Initialize contracts
    await stakedBRB.initialize(
      admin.address,
      "Staked BRB",
      "sBRB", 
      250, // 2.5% protocol fee
      admin.address // fee recipient
    );

    await roulette.initialize(
      admin.address,
      mockAutomationRegistry.target,
      mockAutomationRegistry.target,
      mockLinkToken.target
    );

    // Mint and approve tokens
    const initialAmount = ethers.parseEther("10000");
    await brbToken.connect(admin).transfer(player1.address, initialAmount);
    await brbToken.connect(player1).approve(stakedBRB.target, ethers.MaxUint256);

    // Give admin some LINK tokens
    await mockLinkToken.setBalance(admin.address, ethers.parseEther("1000"));
    await mockLinkToken.connect(admin).approve(roulette.target, ethers.MaxUint256);

    return {
      mockLinkToken: mockLinkToken as MockLinkToken,
      vrfCoordinatorMock,
      mockAutomationRegistry,
      brbToken: brbToken as BRB,
      stakedBRB: stakedBRB as StakedBRB,
      roulette: roulette as RouletteClean,
      admin: admin as HardhatEthersSigner,
      player1: player1 as HardhatEthersSigner,
      player2: player2 as HardhatEthersSigner,
    };
  }

  describe("Upkeep Registration", function () {
    it("Should register VRF upkeep successfully", async function () {
      const { roulette, mockLinkToken, admin } = await loadFixture(deployRouletteFixture);

      const linkAmount = ethers.parseEther("10");

      await expect(
        roulette.connect(admin).registerVRFUpkeep(linkAmount)
      ).to.emit(roulette, "UpkeepRegistered")
       .withArgs(1, ethers.anyValue, ethers.anyValue, linkAmount, 0, "VRF");

      // Check LINK was transferred
      const contractBalance = await mockLinkToken.balanceOf(roulette.target);
      expect(contractBalance).to.equal(linkAmount);
    });

    it("Should register multiple payout upkeeps", async function () {
      const { roulette, mockLinkToken, admin } = await loadFixture(deployRouletteFixture);

      const upkeepCount = 5;
      const linkAmountPerUpkeep = ethers.parseEther("2");
      const totalLinkNeeded = linkAmountPerUpkeep * BigInt(upkeepCount);

      const upkeepIds = await roulette.connect(admin).registerPayoutUpkeeps.staticCall(
        upkeepCount,
        linkAmountPerUpkeep
      );

      await expect(
        roulette.connect(admin).registerPayoutUpkeeps(upkeepCount, linkAmountPerUpkeep)
      ).to.emit(roulette, "MaxSupportedBetsUpdated")
       .withArgs(50, 5); // 5 upkeeps * 10 batch size = 50 max bets

      // Check LINK was transferred
      const contractBalance = await mockLinkToken.balanceOf(roulette.target);
      expect(contractBalance).to.equal(totalLinkNeeded);

      // Check upkeep config was updated
      const config = await roulette.getUpkeepConfig();
      expect(config.maxSupportedBets).to.equal(50);
      expect(config.registeredUpkeepCount).to.equal(5);

      expect(upkeepIds).to.have.length(upkeepCount);
    });

    it("Should reject upkeep registration from non-admin", async function () {
      const { roulette, player1 } = await loadFixture(deployRouletteFixture);

      const linkAmount = ethers.parseEther("10");

      await expect(
        roulette.connect(player1).registerVRFUpkeep(linkAmount)
      ).to.be.reverted; // AccessControl revert
    });

    it("Should enforce bet limits based on registered upkeeps", async function () {
      const { roulette, stakedBRB, brbToken, admin, player1 } = await loadFixture(deployRouletteFixture);

      // Register only 1 payout upkeep (supports 10 bets max)
      await roulette.connect(admin).registerPayoutUpkeeps(1, ethers.parseEther("2"));

      // Stake and try to place more bets than supported
      const stakeAmount = ethers.parseEther("1000");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      // Create 11 bets (exceeds limit of 10)
      const betAmount = ethers.parseEther("1");
      const amounts = Array(11).fill(betAmount);
      const betTypes = Array(11).fill(1); // All straight bets
      const numbers = Array(11).fill(0).map((_, i) => i); // Numbers 0-10

      const totalAmount = betAmount * 11n;
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[amounts, betTypes, numbers]]
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, totalAmount, betData)
      ).to.be.revertedWithCustomError(roulette, "BetLimitExceeded");

      // But 10 bets should work
      const validAmounts = amounts.slice(0, 10);
      const validBetTypes = betTypes.slice(0, 10);
      const validNumbers = numbers.slice(0, 10);
      const validTotalAmount = betAmount * 10n;

      const validBetData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[validAmounts, validBetTypes, validNumbers]]
      );

      await expect(
        brbToken.connect(player1).bet(stakedBRB.target, validTotalAmount, validBetData)
      ).to.not.be.reverted;
    });
  });

  describe("CheckUpkeep Functionality", function () {
    it("Should indicate VRF upkeep needed when conditions are met", async function () {
      const { roulette, stakedBRB, brbToken, admin, player1 } = await loadFixture(deployRouletteFixture);

      // Register upkeeps
      await roulette.connect(admin).registerPayoutUpkeeps(2, ethers.parseEther("2"));

      // Place some bets
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]]
      );

      await brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData);

      // Initially no upkeep needed (game period not passed)
      const [upkeepNeeded1] = await roulette.checkUpkeep("0x");
      expect(upkeepNeeded1).to.be.false;

      // Advance time past game period
      await ethers.provider.send("evm_increaseTime", [70]); // 70 seconds
      await ethers.provider.send("evm_mine", []);

      // Now upkeep should be needed
      const [upkeepNeeded2, performData] = await roulette.checkUpkeep("0x");
      expect(upkeepNeeded2).to.be.true;
      expect(performData).to.not.equal("0x");

      // Decode and verify perform data
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint256,uint256,bytes)"],
        performData
      );
      expect(decoded[1]).to.equal(0); // triggerType = 0 (VRF)
    });

    it("Should check for payout upkeeps after VRF resolution", async function () {
      const { roulette, vrfCoordinatorMock, stakedBRB, brbToken, admin, player1 } = await loadFixture(deployRouletteFixture);

      // Setup and place bets
      await roulette.connect(admin).registerPayoutUpkeeps(2, ethers.parseEther("2"));

      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      const betAmount = ethers.parseEther("10");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount], [1], [7]]] // Bet on number 7
      );

      await brbToken.connect(player1).bet(stakedBRB.target, betAmount, betData);

      // Advance time and resolve VRF
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);

      // Simulate VRF response with winning number 7
      const randomWords = [7n];
      const requestId = 1n;
      await vrfCoordinatorMock.fulfillRandomWords(roulette.target, requestId, randomWords);

      // Check for payout upkeep (batch 0)
      const checkData1 = "0x00"; // Length 1 = batch 0
      const [upkeepNeeded1, performData1] = await roulette.checkUpkeep(checkData1);
      expect(upkeepNeeded1).to.be.true;

      const decoded1 = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(uint256,uint256,bytes)"],
        performData1
      );
      expect(decoded1[1]).to.equal(1); // triggerType = 1 (payout)

      // Check for batch 1 (should not be needed since only 1 winning bet)
      const checkData2 = "0x0000"; // Length 2 = batch 1
      const [upkeepNeeded2] = await roulette.checkUpkeep(checkData2);
      expect(upkeepNeeded2).to.be.false;
    });
  });

  describe("PerformUpkeep Functionality", function () {
    it("Should reject calls from unauthorized addresses", async function () {
      const { roulette, player1 } = await loadFixture(deployRouletteFixture);

      const performData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256,uint256,bytes)"],
        [1, 0, "0x"]
      );

      await expect(
        roulette.connect(player1).performUpkeep(performData)
      ).to.be.revertedWithCustomError(roulette, "OnlyForwarders");
    });

    // Note: Full performUpkeep testing would require setting up proper forwarder addresses
    // from the mock automation registry, which is complex for unit tests.
    // Integration tests would be better for testing the full automation flow.
  });

  describe("Batch Status Tracking", function () {
    it("Should track batch processing status correctly", async function () {
      const { roulette, vrfCoordinatorMock, stakedBRB, brbToken, admin, player1 } = await loadFixture(deployRouletteFixture);

      // Setup
      await roulette.connect(admin).registerPayoutUpkeeps(2, ethers.parseEther("2"));
      
      const stakeAmount = ethers.parseEther("100");
      await stakedBRB.connect(player1).deposit(stakeAmount, player1.address);

      // Place multiple bets to create multiple winning bets
      const betAmount = ethers.parseEther("5");
      const betData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint256[],uint256[],uint256[])"],
        [[[betAmount, betAmount], [8, 1], [0, 7]]] // Red bet + straight bet on 7
      );

      await brbToken.connect(player1).bet(stakedBRB.target, betAmount * 2n, betData);

      // Resolve VRF with winning red number 7
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);
      
      const randomWords = [7n]; // 7 is red, so both bets win
      await vrfCoordinatorMock.fulfillRandomWords(roulette.target, 1n, randomWords);

      // Check initial batch status
      const initialStatus = await roulette.getRoundBatchStatus(1);
      expect(initialStatus.batchesProcessed).to.equal(0);
      expect(initialStatus.totalBatches).to.be.gt(0);
      expect(initialStatus.isFullyProcessed).to.be.false;

      // Check if specific batch is processed
      const batch0Processed = await roulette.isBatchProcessed(1, 0);
      expect(batch0Processed).to.be.false;
    });
  });

  describe("View Functions", function () {
    it("Should return correct upkeep window timing", async function () {
      const { roulette } = await loadFixture(deployRouletteFixture);

      // Initially should be time until next window
      const timeUntilNext1 = await roulette.getSecondsFromNextUpkeepWindow();
      expect(timeUntilNext1).to.be.gt(0);
      expect(timeUntilNext1).to.be.lte(60); // Game period is 60 seconds

      // After advancing time past game period, should be 0 (in upkeep window)
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);

      const timeUntilNext2 = await roulette.getSecondsFromNextUpkeepWindow();
      expect(timeUntilNext2).to.equal(0);
    });

    it("Should check if more bets can be placed correctly", async function () {
      const { roulette, admin } = await loadFixture(deployRouletteFixture);

      // Initially no upkeeps registered, so no bets allowed
      expect(await roulette.canPlaceBets(1)).to.be.false;
      expect(await roulette.canPlaceBets(0)).to.be.true;

      // Register upkeeps
      await roulette.connect(admin).registerPayoutUpkeeps(2, ethers.parseEther("2"));

      // Now 20 bets should be allowed (2 upkeeps * 10 batch size)
      expect(await roulette.canPlaceBets(20)).to.be.true;
      expect(await roulette.canPlaceBets(21)).to.be.false;
    });
  });
});
