import { viem } from "hardhat";

import { expect } from "chai";
import { getAddress, parseUnits, zeroAddress, type Address } from "viem";

async function deployFunder(opts?: { engine?: Address; sideBet?: Address }) {
    const [admin] = await viem.getWalletClients();
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const treasury = await viem.deployContract("JackpotTreasury", [
        brb.address,
        admin.account.address,
        admin.account.address,
    ]);
    const router = await viem.deployContract("MockUniswapV2Router");
    const engine = opts?.engine ?? admin.account.address;
    const sideBet = opts?.sideBet ?? admin.account.address;
    const funder = await viem.deployContract("BRBJackpotFunder", [
        engine,
        brb.address,
        router.address,
        treasury.address,
        sideBet,
        admin.account.address,
    ]);
    return { admin, brb, treasury, router, funder, engine, sideBet };
}

describe("BRBJackpotFunder", function () {
    it("does not revert when swap min would have failed; uses amountOutMin 0 and completes", async function () {
        const { admin, brb, treasury, router, funder } = await deployFunder();
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
        const { admin, brb, treasury, funder } = await deployFunder();

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
        const { admin, funder, router } = await deployFunder();
        await router.write.setForceRevertSwap([true]);
        const usdc = await viem.deployContract("MockUSDC");
        await usdc.write.mint([funder.address, parseUnits("100", 6)]);

        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
        expect(await usdc.read.balanceOf([funder.address])).to.equal(parseUnits("100", 6));
    });

    it("reverts constructor on zero addresses", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const engine = admin.account.address;
        const sideBet = admin.account.address;

        await expect(
            viem.deployContract("BRBJackpotFunder", [zeroAddress, brb.address, router.address, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, zeroAddress, router.address, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, zeroAddress, treasury.address, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, router.address, zeroAddress, sideBet, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("BRBJackpotFunder", [engine, brb.address, router.address, treasury.address, sideBet, zeroAddress]),
        ).to.be.rejected;
    });

    it("exposes brbToken and admin setters with bounds", async function () {
        const { admin, brb, funder } = await deployFunder();

        expect(getAddress(await funder.read.brbToken())).to.equal(getAddress(brb.address));

        await funder.write.setSwapAssetBps([0n], { account: admin.account });
        await expect(funder.write.setSwapAssetBps([1001n], { account: admin.account })).to.be.rejected;

        await funder.write.setTreasuryBrbSplit([1n, 2n], { account: admin.account });
        await expect(funder.write.setTreasuryBrbSplit([2n, 1n], { account: admin.account })).to.be.rejected;
        await expect(funder.write.setTreasuryBrbSplit([1n, 0n], { account: admin.account })).to.be.rejected;

        await funder.write.setSlippageBps([1n], { account: admin.account });
        await expect(funder.write.setSlippageBps([10_000n], { account: admin.account })).to.be.rejected;
    });

    it("reverts admin setters from accounts without FUNDER_ADMIN_ROLE", async function () {
        const [, stranger] = await viem.getWalletClients();
        const { funder } = await deployFunder();

        await expect(funder.write.setSwapAssetBps([300n], { account: stranger.account })).to.be.rejected;
        await expect(funder.write.setTreasuryBrbSplit([250n, 300n], { account: stranger.account })).to.be.rejected;
        await expect(funder.write.setSlippageBps([100n], { account: stranger.account })).to.be.rejected;
    });

    it("fundFromMarket: fee collector guard, empty balance, and sideBet caller", async function () {
        const [admin, stranger] = await viem.getWalletClients();
        const sideBetCaller = await viem.deployContract("SideBet");
        const { brb, funder, engine } = await deployFunder({ sideBet: sideBetCaller.address });

        await expect(funder.write.fundFromMarket([1n, brb.address], { account: stranger.account })).to.be.rejected;
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });

        const testClient = await viem.getTestClient();
        await testClient.impersonateAccount({ address: sideBetCaller.address });
        await testClient.setBalance({ address: sideBetCaller.address, value: parseUnits("1", 18) });
        await brb.write.transfer([funder.address, parseUnits("1", 18)], { account: admin.account });
        await funder.write.fundFromMarket([1n, brb.address], { account: sideBetCaller.address });
        await testClient.stopImpersonatingAccount({ address: sideBetCaller.address });

        expect(getAddress(await funder.read.engine())).to.equal(getAddress(engine));
        expect(getAddress(await funder.read.sideBet())).to.equal(getAddress(sideBetCaller.address));
    });

    it("fundFromMarket: treasury split edges and fee-hook failures", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
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

        await funder.write.setTreasuryBrbSplit([0n, 1n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("3", 18)], { account: admin.account });
        const supplyBeforeBurnOnly = await brb.read.totalSupply();
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.totalSupply()).to.equal(supplyBeforeBurnOnly - parseUnits("3", 18));

        await funder.write.setTreasuryBrbSplit([1000n, 1000n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
        const supplyBeforeTreasuryOnly = await brb.read.totalSupply();
        const treasuryBefore = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.be.gt(treasuryBefore);
        expect(await brb.read.totalSupply()).to.equal(supplyBeforeTreasuryOnly);

        await funder.write.setTreasuryBrbSplit([250n, 300n], { account: admin.account });
        await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
        await brb.write.setFailTransfer([true]);
        const treasuryBeforeFail = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeFail);
        await brb.write.setFailTransfer([false]);

        await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
        await brb.write.setRevertTransfer([true]);
        const treasuryBeforeRevert = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeRevert);
        await brb.write.setRevertTransfer([false]);

        await brb.write.setFailBurn([true]);
        await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        await brb.write.setFailBurn([false]);
    });
});
