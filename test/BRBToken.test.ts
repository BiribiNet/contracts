import { expect } from "chai";
import { parseUnits } from "viem";
import { viem } from "hardhat";

describe("BRBToken", function () {
    it("mints fixed supply and supports burn", async function () {
        const [admin, user] = await viem.getWalletClients();
        const total = parseUnits("3000000", 18);
        const token = await viem.deployContract("BRBToken", [admin.account.address]);

        expect(await token.read.name()).to.equal("BIRIBI");
        expect(await token.read.symbol()).to.equal("BRB");
        expect(await token.read.totalSupply()).to.equal(total);

        await token.write.transfer([user.account.address, parseUnits("100", 18)], { account: admin.account });
        await token.write.burn([parseUnits("10", 18)], { account: user.account });

        expect(await token.read.balanceOf([user.account.address])).to.equal(parseUnits("90", 18));
        expect(await token.read.totalSupply()).to.equal(total - parseUnits("10", 18));
    });
});
