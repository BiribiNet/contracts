import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("BankVault4626", function () {
    it("handles bets, liquidity locking and total assets", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const vault = await viem.deployContract("BankVault4626", [
            usdc.address,
            "Bank USDC",
            "bUSDC",
            1,
            mockEngine.address,
            admin.account.address,
        ]);

        await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([vault.address, parseUnits("500", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        expect(await vault.read.totalAssets()).to.equal(parseUnits("100", 6));
        await vault.write.placeBet([parseUnits("10", 6), "0x"], { account: alice.account });
        expect(await vault.read.lockedBetLiquidity()).to.equal(parseUnits("10", 6));
        expect(await vault.read.totalAssets()).to.equal(parseUnits("100", 6));
    });

    it("enforces guards and engine-only methods", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const vault = await viem.deployContract("BankVault4626", [
            usdc.address,
            "Bank USDC",
            "bUSDC",
            1,
            mockEngine.address,
            admin.account.address,
        ]);

        await expect(vault.write.placeBet([0n, "0x"], { account: alice.account })).to.be.rejected;
        await expect(vault.write.releaseBets([1n], { account: alice.account })).to.be.rejected;
        await expect(vault.write.payoutBatch([[{ player: alice.account.address, amount: 1n }]], { account: alice.account })).to
            .be.rejected;
    });

    it("caps release and validates payout recipients", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const vault = await viem.deployContract("BankVault4626", [
            usdc.address,
            "Bank USDC",
            "bUSDC",
            1,
            mockEngine.address,
            admin.account.address,
        ]);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.placeBet([parseUnits("40", 6), "0x"], { account: alice.account });
        expect(await vault.read.lockedBetLiquidity()).to.equal(parseUnits("40", 6));

        await mockEngine.write.releaseFromVault([vault.address, parseUnits("999", 6)]);
        expect(await vault.read.lockedBetLiquidity()).to.equal(0n);

        await usdc.write.mint([vault.address, parseUnits("10", 6)]);
        await expect(
            mockEngine.write.payoutFromVault([vault.address, [{ player: "0x0000000000000000000000000000000000000000", amount: 1n }]]),
        ).to.be.rejected;
    });
});
