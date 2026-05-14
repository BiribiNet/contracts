import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("BRBJackpotFunder", function () {
    it("does not revert when swap min would have failed; uses amountOutMin 0 and completes", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        await brb.write.transfer([router.address, parseUnits("100000", 18)], { account: admin.account });

        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        const treasuryAfter = await brb.read.balanceOf([treasury.address]);

        const swapIn = parseUnits("100", 6);
        const brbOut = swapIn * 10n ** 12n;
        const toTreasury = (brbOut * 250n) / 300n;
        expect(treasuryAfter - treasuryBefore).to.equal(toTreasury);
    });

    it("native BRB asset: splits fee slice without router swap", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);

        const swapIn = parseUnits("3", 18);
        await brb.write.transfer([funder.address, swapIn], { account: admin.account });

        const supplyBefore = await brb.read.totalSupply();
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        const treasuryAfter = await brb.read.balanceOf([treasury.address]);

        const toTreasury = (swapIn * 250n) / 300n;
        const toBurn = swapIn - toTreasury;
        expect(treasuryAfter - treasuryBefore).to.equal(toTreasury);
        expect(await brb.read.totalSupply()).to.equal(supplyBefore - toBurn);
    });

    it("returns without revert when router swap reverts", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        await router.write.setForceRevertSwap([true]);
        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("100", 6));
    });
});
