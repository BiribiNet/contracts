import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("BRBJackpotFunder", function () {
    it("reverts swap when min BRB out is above mock router output", async function () {
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

        await funder.write.setBrbPerAssetUnitRatio([1n, 10n ** 40n], { account: admin.account });

        await expect(funder.write.fundFromMarket([1n, usdc.address, parseUnits("100", 6)], { account: admin.account })).to.be
            .rejected;
    });
});
