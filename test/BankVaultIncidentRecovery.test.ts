import { ethers } from "hardhat";
import { expect } from "chai";
const HOLDER = "0x2f2B6a18a43f94c4b4a0Ca03215B45Cf15ca17C1";
const archived = require("../reports/incident-2026-11-04/recovery-artifacts.json").BankVault4626;

describe("Incident recovery burns vault shares only", function () {
    it("burns the current holder shares, preserves BRB balances and rejects other callers", async function () {
        const [admin, outsider] = await ethers.getSigners();
        const token = await (await ethers.getContractFactory("BRBToken")).deploy(admin.address);
        const engine = await (await ethers.getContractFactory("MockEngine")).deploy();
        const recovery = await (await ethers.getContractFactory("MockIncidentTicketRecovery")).deploy();
        const impl = await new ethers.ContractFactory(archived.abi, archived.bytecode, admin).deploy();
        const init = impl.interface.encodeFunctionData("initialize", [{ assetToken: await token.getAddress(), name: "Recovery test", symbol: "bTEST",
            marketId: 1, engine: await engine.getAddress(), admin: admin.address, minBet: 1n, sideBetController: await recovery.getAddress() }]);
        const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), init);
        const bank: any = new ethers.Contract(await proxy.getAddress(), archived.abi, admin);
        await token.approve(await bank.getAddress(), ethers.MaxUint256);
        await bank.deposit(ethers.parseEther("1000"), admin.address);
        const shares = (await bank.balanceOf(admin.address)) / 3n + 123n;
        await bank.transfer(HOLDER, shares);
        await token.transfer(HOLDER, ethers.parseEther("396"));
        const bankBRB = await token.balanceOf(await bank.getAddress()), holderBRB = await token.balanceOf(HOLDER);
        const shareSupply = await bank.totalSupply(), tokenSupply = await token.totalSupply();
        const adminShares = await bank.balanceOf(admin.address);
        await expect(bank.connect(outsider).recoverNovember2026()).to.be.reverted;
        await recovery.setFail(true);
        await expect(bank.recoverNovember2026()).to.be.revertedWith("test cancellation failed");
        expect(await bank.balanceOf(HOLDER)).to.equal(shares);
        await recovery.setFail(false);
        await expect(bank.recoverNovember2026()).to.emit(bank, "Transfer").withArgs(HOLDER, ethers.ZeroAddress, shares);
        expect(await bank.balanceOf(HOLDER)).to.equal(0n);
        expect(await bank.totalSupply()).to.equal(shareSupply - shares);
        expect(await bank.balanceOf(admin.address)).to.equal(adminShares);
        expect(await token.totalSupply()).to.equal(tokenSupply);
        expect(await token.balanceOf(HOLDER)).to.equal(holderBRB);
        expect(await token.balanceOf(await bank.getAddress())).to.equal(bankBRB);
        await bank.recoverNovember2026();
        expect(await bank.totalSupply()).to.equal(shareSupply - shares);
        expect(bank.interface.hasFunction("recoverNovember2026BRB")).to.equal(false);
        expect(await recovery.calls()).to.equal(2n);
    });
});
