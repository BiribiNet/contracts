import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { keccak256, parseUnits, toBytes, zeroAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";

describe("Branch coverage — 100% branch targets", function () {
    it("BRBJackpotFunder: setTwapWindowSeconds role, sweepToken guards, partial sweep", async function () {
        const [admin, stranger, recipient] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        const usdc = await viem.deployContract("MockUSDC");

        await expect(funder.write.setTwapWindowSeconds([60], { account: stranger.account })).to.be.rejected;
        await expect(
            funder.write.sweepToken([usdc.address, recipient.account.address, 1n], { account: stranger.account }),
        ).to.be.rejected;
        await expect(
            funder.write.sweepToken([zeroAddress, recipient.account.address, 0n], { account: admin.account }),
        ).to.be.rejected;
        await expect(
            funder.write.sweepToken([usdc.address, zeroAddress, 0n], { account: admin.account }),
        ).to.be.rejected;
        await expect(
            funder.write.sweepToken([usdc.address, recipient.account.address, 0n], { account: admin.account }),
        ).to.be.rejected;

        await usdc.write.mint([funder.address, parseUnits("100", 6)]);
        const partial = parseUnits("40", 6);
        await funder.write.sweepToken([usdc.address, recipient.account.address, partial], {
            account: admin.account,
        });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("60", 6));
        expect(await usdc.read.balanceOf([recipient.account.address])).to.equal(partial);
    });

    it("RouletteEngine: zero jackpot admin setters and unknown VRF request", async function () {
        const [admin, stranger] = await viem.getWalletClients();
        const { engine, vrf } = await deployProtocolStack();
        const feeRole = keccak256(toBytes("ENGINE_FEE_ROLE"));
        await engine.write.grantRole([feeRole, admin.account.address], { account: admin.account });

        await expect(engine.write.setJackpotFunder([zeroAddress], { account: admin.account })).to.be.rejected;
        await expect(engine.write.setJackpotTreasury([zeroAddress], { account: admin.account })).to.be.rejected;
        await expect(
            engine.write.setJackpotFunder([admin.account.address], { account: stranger.account }),
        ).to.be.rejected;
        await expect(
            engine.write.setJackpotTreasury([admin.account.address], { account: stranger.account }),
        ).to.be.rejected;
        await expect(vrf.write.fulfill([engine.address, 999n, 1n])).to.be.rejected;
    });

    it("BankVault4626: redeemBps owner guard and mint during resolution lock", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const { engine, scheduler, registry } = await deployProtocolStack();
        const usdc = await viem.deployContract("MockUSDC");
        const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

        await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

        await usdc.write.mint([alice.account.address, parseUnits("500", 6)]);
        await usdc.write.approve([bank.address, parseUnits("500", 6)], { account: alice.account });
        await bank.write.deposit([parseUnits("200", 6), alice.account.address], { account: alice.account });

        await usdc.write.mint([bob.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: bob.account });
        await bank.write.deposit([parseUnits("50", 6), bob.account.address], { account: bob.account });

        await expect(
            bank.write.redeemBps([1_000, bob.account.address, bob.account.address], { account: alice.account }),
        ).to.be.rejected;
        await expect(
            bank.write.withdraw([parseUnits("1", 6), alice.account.address, bob.account.address], {
                account: alice.account,
            }),
        ).to.be.rejected;

        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
        await bank.write.placeBet(
            [parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress],
            { account: alice.account },
        );

        await time.increase(550);
        const [, preLock] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLock]);
        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);

        const shares = await bank.read.convertToShares([parseUnits("100", 6)]);
        const assets = await bank.read.previewMint([shares]);
        expect(assets).to.be.gt(await bank.read.flatWithdrawFee());
        await expect(bank.write.mint([shares, alice.account.address], { account: alice.account })).to.be.rejected;
    });
});
