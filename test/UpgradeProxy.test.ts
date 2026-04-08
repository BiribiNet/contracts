import { viem } from "hardhat";
import { expect } from "chai";
import { parseEther, zeroAddress } from "viem";

import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

describe("Proxy Upgrade Tests", function () {
  describe("StakedBRB — access control for upgrade", function () {
    it("Should reject upgrade from non-admin", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      // Deploy a dummy implementation (address only matters, won't actually run)
      // Using zeroAddress would revert earlier, so use any address
      await expect(
        stakedBrbProxy.write.upgradeToAndCall([player1.account.address, "0x"], {
          account: player1.account,
        })
      ).to.be.rejected;
    });
  });

  describe("RouletteClean — access control for upgrade", function () {
    it("Should reject upgrade from non-admin", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      await expect(
        rouletteProxy.write.upgradeToAndCall([player1.account.address, "0x"], {
          account: player1.account,
        })
      ).to.be.rejected;
    });
  });

  describe("Pausable", function () {
    it("Should allow admin to pause and unpause StakedBRB", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();

      expect(await stakedBrbProxy.read.paused()).to.equal(false);
      await stakedBrbProxy.write.pause();
      expect(await stakedBrbProxy.read.paused()).to.equal(true);
      await stakedBrbProxy.write.unpause();
      expect(await stakedBrbProxy.read.paused()).to.equal(false);
    });

    it("Should allow admin to pause and unpause RouletteClean", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      expect(await rouletteProxy.read.paused()).to.equal(false);
      await rouletteProxy.write.pause();
      expect(await rouletteProxy.read.paused()).to.equal(true);
      await rouletteProxy.write.unpause();
      expect(await rouletteProxy.read.paused()).to.equal(false);
    });

    it("Should reject pause from non-admin on StakedBRB", async function () {
      const { stakedBrbProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      await expect(
        stakedBrbProxy.write.pause({ account: player1.account })
      ).to.be.rejected;
    });

    it("Should reject pause from non-admin on RouletteClean", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      await expect(
        rouletteProxy.write.pause({ account: player1.account })
      ).to.be.rejected;
    });

    it("Should block bets when StakedBRB is paused", async function () {
      const { stakedBrbProxy, brb } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      // Fund player
      const betAmount = parseEther("100");
      await brb.write.transfer([player1.account.address, betAmount]);

      // Pause
      await stakedBrbProxy.write.pause();

      // Try to bet via BRB.bet() — calls onTokenTransfer which should revert when paused
      await expect(
        brb.write.bet(
          [
            stakedBrbProxy.address,
            betAmount,
            // Encoded MultipleBets: 1 straight bet of 100 BRB on number 17
            "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000",
            zeroAddress,
          ],
          { account: player1.account }
        )
      ).to.be.rejected;
    });
  });

  describe("Configurable batch size", function () {
    it("Should allow admin to set batch size", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      await rouletteProxy.write.setBatchSize([50]);
      // Read via getConstants
      const [, batchSize] = await rouletteProxy.read.getConstants();
      expect(batchSize).to.equal(50n);
    });

    it("Should reject invalid batch size (too low)", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      await expect(rouletteProxy.write.setBatchSize([5])).to.be.rejected;
    });

    it("Should reject invalid batch size (too high)", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();

      await expect(rouletteProxy.write.setBatchSize([200])).to.be.rejected;
    });

    it("Should reject setBatchSize from non-admin", async function () {
      const { rouletteProxy } = await useDeployWithCreateFixture();
      const [, player1] = await viem.getWalletClients();

      await expect(
        rouletteProxy.write.setBatchSize([50], { account: player1.account })
      ).to.be.rejected;
    });
  });
});
