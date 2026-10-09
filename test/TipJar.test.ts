import { expect } from "chai";
import { ethers } from "hardhat";

describe("TipJar", function () {
    async function fixture() {
        const [sender, recipient, other] = await ethers.getSigners();
        const token = await (await ethers.getContractFactory("TipTokenMock")).deploy();
        const engine = await (await ethers.getContractFactory("TipEngineMock")).deploy(recipient.address);
        const jar = await (await ethers.getContractFactory("TipJar")).deploy(await token.getAddress(), await engine.getAddress());
        return { sender, recipient, other, token, engine, jar };
    }

    it("transfers the exact amount directly and emits attributable evidence", async function () {
        const { sender, recipient, token, jar } = await fixture();
        const amount = ethers.parseEther("0.125");
        await token.approve(await jar.getAddress(), amount);
        await expect(jar.tip(amount)).to.emit(jar, "TipSent")
            .withArgs(sender.address, await token.getAddress(), recipient.address, amount);
        expect(await token.balanceOf(recipient.address)).to.equal(amount);
        expect(await token.balanceOf(await jar.getAddress())).to.equal(0n);
        expect(await token.allowance(sender.address, await jar.getAddress())).to.equal(0n);
    });

    it("rejects zero, missing allowance, insufficient funds and spending another wallet's allowance", async function () {
        const { other, token, jar } = await fixture();
        await expect(jar.tip(0n)).to.be.revertedWithCustomError(jar, "InvalidAmount");
        await expect(jar.tip(1n)).to.be.reverted;
        await token.approve(await jar.getAddress(), ethers.MaxUint256);
        await expect(jar.tip(ethers.parseEther("1001"))).to.be.reverted;
        await expect(jar.connect(other).tip(1n)).to.be.reverted;
    });

    it("rejects invalid configuration and self contributions", async function () {
        const { recipient, token, engine, jar } = await fixture();
        const factory = await ethers.getContractFactory("TipJar");
        await expect(factory.deploy(ethers.ZeroAddress, await engine.getAddress())).to.be.revertedWithCustomError(factory, "InvalidConfiguration");
        const emptyEngine = await (await ethers.getContractFactory("TipEngineMock")).deploy(ethers.ZeroAddress);
        await expect(factory.deploy(await token.getAddress(), await emptyEngine.getAddress())).to.be.revertedWithCustomError(factory, "InvalidConfiguration");
        await expect(jar.connect(recipient).tip(1n)).to.be.revertedWithCustomError(jar, "InvalidAmount");
    });

    it("rolls back taxed transfers instead of emitting an incorrect contribution", async function () {
        const { sender, recipient, token, jar } = await fixture();
        await token.approve(await jar.getAddress(), 100n);
        await token.setTax(true);
        await expect(jar.tip(100n)).to.be.revertedWithCustomError(jar, "UnexpectedReceivedAmount");
        expect(await token.balanceOf(recipient.address)).to.equal(0n);
        expect(await token.allowance(sender.address, await jar.getAddress())).to.equal(100n);
    });

    it("rejects reentrant token callbacks and false-returning token transfers", async function () {
        const { recipient, token, jar } = await fixture();
        await token.approve(await jar.getAddress(), 100n);
        await token.setReentry(await jar.getAddress());
        await expect(jar.tip(100n)).to.be.revertedWithCustomError(jar, "ReentrancyGuardReentrantCall");
        await token.setReentry(ethers.ZeroAddress);
        await token.setFalseReturn(true);
        await expect(jar.tip(100n)).to.be.revertedWithCustomError(jar, "SafeERC20FailedOperation");
        expect(await token.balanceOf(recipient.address)).to.equal(0n);
    });
});
