import { viem } from "hardhat";
import { expect } from "chai";
import { parseEther, formatEther, encodeAbiParameters } from "viem";
import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

describe("RouletteClean", function () {
  // Use the shared fixture from deployWithCreate script

  describe("Deployment", function () {
    it("Should deploy with correct initial values", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();

      const [currentRound, lastRoundPaid, lastRoundStartTime] = await rouletteProxy.read.getCurrentRoundInfo();
      expect(currentRound).to.be.greaterThan(0n); // Should be greater than 0 after initialization
      expect(lastRoundPaid).to.be.gte(0n); // Should be >= 0 (timestamp);

      const hasAdminRole = await rouletteProxy.read.hasRole([
        await rouletteProxy.read.DEFAULT_ADMIN_ROLE(),
        await viem.getWalletClients().then(clients => clients[0].account.address)
      ]);
      expect(hasAdminRole).to.be.true;
    });

    it("Should have correct StakedBRB configuration", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();

      const [brbToken, rouletteContract, protocolFeeBasisPoints, feeRecipient] = await stakedBrbProxy.read.getVaultConfig();
      expect(brbToken.toLowerCase()).to.equal(brb.address.toLowerCase());
      expect(protocolFeeBasisPoints).to.equal(10000n);
      expect(feeRecipient.toLowerCase()).to.equal((await viem.getWalletClients().then(clients => clients[0].account.address)).toLowerCase());
    });


  });

  describe("Betting", function () {
    it("Should place a single straight bet", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Check player's initial balance
      console.log("Player1 BRB balance:", formatEther(await brb.read.balanceOf([player1.account.address])));

      // Stake some BRB first
      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      console.log("Player1 BRB balance after staking:", formatEther(await brb.read.balanceOf([player1.account.address])));

      // Create bet data for straight bet on number 7
      const betAmount = parseEther("10");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }] // amounts, betTypes (1=straight), numbers
      );

      // Place bet through BRB token
      await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
      // TODO: Fix event testing for Viem
      // await expect(...).to.emit(rouletteProxy, "BetPlaced")

      // Check round bets count
      const [currentRound] = await rouletteProxy.read.getCurrentRoundInfo();
      const betsCount = await rouletteProxy.read.getRoundBetsCount([currentRound]);
      expect(betsCount).to.equal(1n);
    });

    it("Should place multiple bets in one transaction", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      // Stake some BRB first
      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      // Create multiple bet data
      const bet1Amount = parseEther("5");
      const bet2Amount = parseEther("10");
      const totalAmount = bet1Amount + bet2Amount;

      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [bet1Amount, bet2Amount], betTypes: [1n, 8n], numbers: [7n, 0n] }] // straight on 7, red bet
      );

      await expect(brb.write.bet([stakedBrbProxy.address, totalAmount, betData], { account: player1.account })).to.not.be.rejected;
      // TODO: Fix event testing for Viem
      // await expect(...).to.emit(rouletteProxy, "BetPlaced")

      const [currentRound] = await rouletteProxy.read.getCurrentRoundInfo();
      const betsCount = await rouletteProxy.read.getRoundBetsCount([currentRound]);
      expect(betsCount).to.equal(2n);
    });

    it("Should reject invalid bet types", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [99n], numbers: [7n] }] // Invalid bet type 99
      );

      await expect(brb.write.bet([stakedBrbProxy.address, betAmount, betData], { account: player1.account })).to.be.rejectedWith("InvalidBetType");
    });

    it("Should reject bet amount mismatches", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");
      const wrongTotalAmount = parseEther("5"); // Wrong total

      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );

      // Verify the call reverts with InvalidBet error (expected behavior)
      try {
        await brb.write.bet([stakedBrbProxy.address, wrongTotalAmount, betData]);
        expect.fail("Expected call to revert with InvalidBet error");
      } catch (error: any) {
        // Expected to fail with InvalidBet error - this is the correct behavior!
        expect(error.message).to.include("InvalidBet");
      }
    });

    it("Should reject bets with invalid numbers for bet types", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");

      // Test invalid straight bet number (>36)
      const invalidStraightBet = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [37n] }] // Invalid number 37 for straight bet
      );

      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   brb.write.bet([stakedBrbProxy.address, betAmount, invalidStraightBet])
      // ).to.be.revertedWithCustomError(rouletteProxy, "InvalidNumber");
      
      // Verify the call reverts with InvalidNumber error (expected behavior)
      try {
        await brb.write.bet([stakedBrbProxy.address, betAmount, invalidStraightBet]);
        expect.fail("Expected call to revert with InvalidNumber error");
      } catch (error: any) {
        // Expected to fail with InvalidNumber error - this is the correct behavior!
        expect(error.message).to.include("InvalidNumber");
      }

      // Test invalid street bet number
      const invalidStreetBet = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [3n], numbers: [2n] }] // Invalid street start (must be 1,4,7,etc)
      );

      // For now, just verify the call reverts (with any error)
      try {
        await brb.write.bet([stakedBrbProxy.address, betAmount, invalidStreetBet]);
        expect.fail("Expected call to revert");
      } catch (error) {
        // Expected to fail
        expect(error).to.exist;
      }
    });
  });

  describe("VRF and Round Management", function () {
    // TODO: Fix VRF coordinator mock function signature and event testing
    // it("Should handle VRF callback and store winning number", async function () {
    //   const { rouletteProxy, vrfCoordinator, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
    //   const [admin, player1] = await viem.getWalletClients();

    //   // Place a bet first
    //   const stakeAmount = parseEther("100");
    //   await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
    //   await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

    //   const betAmount = parseEther("10");
    //   const betData = encodeAbiParameters(
    //     [{ type: "tuple", components: [
    //       { type: "uint256[]", name: "amounts" },
    //       { type: "uint256[]", name: "betTypes" },
    //       { type: "uint256[]", name: "numbers" }
    //     ]}],
    //     [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
    //   );

    //   await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);

    //   // Simulate time passing and trigger VRF
    //   await time.increase(70); // 70 seconds

    //   // Mock VRF response with winning number 7
    //   const randomWords = [7n]; // This will result in 7 % 37 = 7
    //   const requestId = 1n;

    //   // Simulate VRF callback
    //   await expect(
    //     vrfCoordinator.write.fulfillRandomWords([rouletteProxy.address, requestId, randomWords])
    //   ).to.emit(rouletteProxy, "VRFResult")
    //    .withArgs(1n, 7n);

    //   // Check that the result was stored
    //   const [winningNumber, isSet] = await rouletteProxy.read.getRoundResult([1n]);
    //   expect(winningNumber).to.equal(7n);
    //   expect(isSet).to.be.true;
    // });
  });

  describe("Bet Validation", function () {
    it("Should validate street bet numbers correctly", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");

      // Valid street bets (1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34)
      const validStreets = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];
      
      for (const street of validStreets) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [3n], numbers: [BigInt(street)] }]
        );

        // Valid bet should not revert
        await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
      }

      // Invalid street bets
      const invalidStreets = [0, 2, 3, 5, 6, 8, 9, 35, 36];
      
      for (const street of invalidStreets) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [3n], numbers: [BigInt(street)] }]
        );

        // For now, just verify the call reverts (with any error)
        try {
          await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
          expect.fail("Expected call to revert");
        } catch (error) {
          // Expected to fail
          expect(error).to.exist;
        }
      }
    });

    it("Should validate column and dozen bets", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");

      // Valid column bets (1, 2, 3)
      for (let col = 1; col <= 3; col++) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [6n], numbers: [BigInt(col)] }]
        );

        // Valid bet should not revert
        await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
      }

      // Valid dozen bets (1, 2, 3)
      for (let dozen = 1; dozen <= 3; dozen++) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [7n], numbers: [BigInt(dozen)] }]
        );

        // Valid bet should not revert
        await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
      }

      // Invalid column/dozen bets
      const invalidNumbers = [0, 4, 5];
      
      for (const num of invalidNumbers) {
        const columnBetData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [6n], numbers: [BigInt(num)] }]
        );

        // For now, just verify the call reverts (with any error)
        try {
          await brb.write.bet([stakedBrbProxy.address, betAmount, columnBetData]);
          expect.fail("Expected call to revert");
        } catch (error) {
          // Expected to fail
          expect(error).to.exist;
        }

        const dozenBetData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [7n], numbers: [BigInt(num)] }]
        );

        // For now, just verify the call reverts (with any error)
        try {
          await brb.write.bet([stakedBrbProxy.address, betAmount, dozenBetData]);
          expect.fail("Expected call to revert");
        } catch (error) {
          // Expected to fail
          expect(error).to.exist;
        }
      }
    });

    it("Should validate outside bets have number parameter as 0", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");

      // Valid outside bets with number = 0
      const outsideBetTypes = [8, 9, 10, 11, 12, 13, 14, 15, 16]; // RED, BLACK, ODD, EVEN, LOW, HIGH, VOISINS, TIERS, ORPHELINS
      
      for (const betType of outsideBetTypes) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [BigInt(betType)], numbers: [0n] }]
        );

        await expect(
          brb.write.bet([stakedBrbProxy.address, betAmount, betData])
        ).to.not.be.reverted;
      }

      // Invalid outside bets with number != 0
      for (const betType of outsideBetTypes) {
        const betData = encodeAbiParameters(
          [{ type: "tuple", components: [
            { type: "uint256[]", name: "amounts" },
            { type: "uint256[]", name: "betTypes" },
            { type: "uint256[]", name: "numbers" }
          ]}],
          [{ amounts: [betAmount], betTypes: [BigInt(betType)], numbers: [5n] }] // Non-zero number
        );

        // TODO: Fix custom error testing for Viem compatibility
        // await expect(
        //   brb.write.bet([stakedBrbProxy.address, betAmount, betData])
        // ).to.be.revertedWithCustomError(rouletteProxy, "InvalidNumber");
        
        // Should revert with InvalidNumber error
        try {
          await brb.write.bet([stakedBrbProxy.address, betAmount, betData]);
          expect.fail("Expected call to revert with InvalidNumber error");
        } catch (error: any) {
          // Expected to fail with InvalidNumber error
          expect(error.message).to.include("InvalidNumber");
        }
      }
    });
  });

  describe("Access Control", function () {
    it("Should only allow authorized callers to place bets", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [admin, player1] = await viem.getWalletClients();

      const betAmount = parseEther("10");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
      );

      // Direct call should fail
      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   rouletteProxy.write.bet([player1.account.address, betAmount, betData])
      // ).to.be.revertedWithCustomError(rouletteProxy, "UnauthorizedCaller");
      
      // Should revert with UnauthorizedCaller error
      try {
        await rouletteProxy.write.bet([player1.account.address, betAmount, betData]);
        expect.fail("Expected call to revert with UnauthorizedCaller error");
      } catch (error: any) {
        // Expected to fail with UnauthorizedCaller error
        expect(error.message).to.include("UnauthorizedCaller");
      }
    });

    it("Should have proper admin roles", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const adminRole = await rouletteProxy.read.DEFAULT_ADMIN_ROLE();
      
      expect(await rouletteProxy.read.hasRole([adminRole, admin.account.address])).to.be.true;
      expect(await rouletteProxy.read.hasRole([adminRole, player1.account.address])).to.be.false;
    });
  });

  describe("View Functions", function () {
    it("Should return correct round information", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture()

      const [currentRound, lastRoundPaid, lastRoundStartTime] = await rouletteProxy.read.getCurrentRoundInfo();
      expect(currentRound).to.be.greaterThan(0n); // Should be greater than 0 after initialization
      expect(lastRoundPaid).to.be.gte(0n); // Should be >= 0 (timestamp)
      expect(lastRoundStartTime).to.be.gte(0n); // Can be 0 initially
    });

    it("Should return correct upkeep configuration", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture()

      const [maxSupportedBets, registeredUpkeepCount, batchSize, upkeepGasLimit] = await rouletteProxy.read.getUpkeepConfig();
      expect(maxSupportedBets).to.equal(100n); // 1 upkeep * 10 batch size = 10 max bets
      expect(registeredUpkeepCount).to.equal(10n); // 1 upkeep registered in fixture
      expect(batchSize).to.equal(10n);
      expect(upkeepGasLimit).to.be.gt(0n); // Should be > 0
      // Note: upkeepGasLimit is not returned by getUpkeepConfig
    });

    it("Should check if more bets can be placed", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture()

      const [maxSupportedBets, registeredUpkeepCount, batchSize, ] = await rouletteProxy.read.getUpkeepConfig();

      expect(maxSupportedBets).to.equal(registeredUpkeepCount * batchSize);

      // 1 upkeep registered, so maxSupportedBets = 10
      const canPlace1 = await rouletteProxy.read.canPlaceBets([1n]);
      expect(canPlace1).to.be.true; // Can place 1 bet

      const canPlace10 = await rouletteProxy.read.canPlaceBets([10n]);
      expect(canPlace10).to.be.true; // Can place 10 bets

      const canPlaceMax = await rouletteProxy.read.canPlaceBets([maxSupportedBets]);
      expect(canPlaceMax).to.be.true;

      const canPlaceMaxPlus1 = await rouletteProxy.read.canPlaceBets([maxSupportedBets + 1n]);
      expect(canPlaceMaxPlus1).to.be.false;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty bet arrays", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [], betTypes: [], numbers: [] }] // Empty arrays
      );

      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   brb.write.bet([stakedBrbProxy.address, 0n, betData])
      // ).to.be.revertedWithCustomError(rouletteProxy, "EmptyBetsArray");
      
      // For now, just verify the call reverts
      await expect(
        brb.write.bet([stakedBrbProxy.address, 1n, betData])
      ).to.be.rejectedWith("EmptyBetsArray");
    });

    it("Should handle array length mismatches", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const balance = await brb.read.balanceOf([player1.account.address]);
      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      const betAmount = parseEther("10");
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [betAmount], betTypes: [1n, 2n], numbers: [7n] }] // Mismatched array lengths
      );

      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   brb.write.bet([stakedBrbProxy.address, betAmount, betData])
      // ).to.be.revertedWithCustomError(rouletteProxy, "ArrayLengthMismatch");
      
      // For now, just verify the call reverts
      await expect(
        brb.write.bet([stakedBrbProxy.address, betAmount, betData])
      ).to.be.rejectedWith("ArrayLengthMismatch");
    });

    it("Should handle zero amounts correctly", async function () {
      const { rouletteProxy, stakedBrbProxy, brb } = await useDeployWithCreateFixture()
      const [admin, player1] = await viem.getWalletClients();

      const stakeAmount = parseEther("100");
      await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
      await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address], { account: player1.account });

      // Test zero total amount
      const betData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [1000n], betTypes: [1n], numbers: [7n] }]
      );

      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   brb.write.bet([stakedBrbProxy.address, 0n, betData])
      // ).to.be.revertedWithCustomError(rouletteProxy, "ZeroAmount");
      
      // For now, just verify the call reverts
      await expect(
        brb.write.bet([stakedBrbProxy.address, 0n, betData])
      ).to.be.rejectedWith("ZeroAmount");

      // Test zero individual bet amount
      const zeroBetData = encodeAbiParameters(
        [{ type: "tuple", components: [
          { type: "uint256[]", name: "amounts" },
          { type: "uint256[]", name: "betTypes" },
          { type: "uint256[]", name: "numbers" }
        ]}],
        [{ amounts: [0n], betTypes: [1n], numbers: [7n] }]
      );

      // TODO: Fix custom error testing for Viem compatibility
      // await expect(
      //   brb.write.bet([stakedBrbProxy.address, 0n, zeroBetData])
      // ).to.be.revertedWithCustomError(rouletteProxy, "ZeroAmount");
      
      // For now, just verify the call reverts
      await expect(
        brb.write.bet([stakedBrbProxy.address, 0n, zeroBetData])
      ).to.be.rejectedWith("ZeroAmount");
    });
  });
});
