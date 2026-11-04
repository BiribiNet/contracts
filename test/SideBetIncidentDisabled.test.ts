import { ethers } from "hardhat";
import { expect } from "chai";

describe("SideBet incident freeze", function () {
    it("disables all placement/settlement endpoints and offers no work to the scheduler", async function () {
        const [admin, user] = await ethers.getSigners();
        const engine = await (await ethers.getContractFactory("MockRoundEngine")).deploy();
        const impl = await (await ethers.getContractFactory("SideBet")).deploy();
        const init = impl.interface.encodeFunctionData("initialize", [admin.address, await engine.getAddress(), admin.address, 50_000, 5_000_000]);
        const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), init);
        const side = await ethers.getContractAt("SideBet", await proxy.getAddress());
        await side.grantRole(await side.SETTLEMENT_ROLE(), admin.address);
        expect(await side.sideBetsDisabled()).to.equal(false);
        await expect(side.connect(user).setSideBetsDisabled(true)).to.be.reverted;
        await side.setSideBetsDisabled(true);
        expect(await side.sideBetsDisabled()).to.equal(true);
        await expect(side.connect(user).placeBet(51, 1n)).to.be.revertedWithCustomError(side, "SideBetsDisabled");
        await expect(side.settleBatch([], [])).to.be.revertedWithCustomError(side, "SideBetsDisabled");
        await expect(side.settleBatchV2([], [])).to.be.revertedWithCustomError(side, "SideBetsDisabled");
        const legacy = await side.previewSettleBundle(0, 10, 0, 2);
        const v2 = await side.previewSettleBundleV2(0, 10, 0, 2);
        expect(legacy[0].length).to.equal(0); expect(v2[0].length).to.equal(0);
        expect(await side.isConfigActive(51)).to.equal(false);
        expect(await side.isResolvable(9)).to.equal(false);
        expect(await side.betCount()).to.equal(0n);
        await side.setSideBetsDisabled(false);
        expect(await side.sideBetsDisabled()).to.equal(false);
        await side.setSideBetsDisabled(true);
        expect(await side.sideBetsDisabled()).to.equal(true);
    });
});
