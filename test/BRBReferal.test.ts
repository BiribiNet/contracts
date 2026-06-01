import { viem } from "hardhat";

import { expect } from "chai";
import { encodeAbiParameters, getAddress, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

async function deployReferralStack() {
    const [admin, alice, bob, carol] = await viem.getWalletClients();
    const usdc = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const mockRouter = await viem.deployContract("MockUniswapV2Router");
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, brbReferral, registry } = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            zeroAddress,
            zeroAddress,
            zeroAddress,
            admin.account.address,
            vrf.address,
            1n,
            2_000_000,
            1,
            500,
            admin.account.address,
        ],
        { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
        {
            protocolPrefix: {
                brb: brb.address,
                mockRouter: mockRouter.address,
                admin: admin.account.address,
            },
            deployBrbReferral: true,
        },
    );

    const referral = await viem.getContractAt("BRBReferal", brbReferral);
    expect(getAddress(await engine.read.BRB_REFERRAL())).to.equal(getAddress(referral.address));

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
        { account: admin.account },
    );
    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    await usdc.write.mint([admin.account.address, parseUnits("3000", 6)]);
    await usdc.write.approve([bank.address, parseUnits("3000", 6)], { account: admin.account });
    await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

    const betAmount = parseUnits("10", 6);
    const betData = encodeSingleBet(1n, 7n, betAmount);
    await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
    await usdc.write.mint([bob.account.address, parseUnits("100", 6)]);
    await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
    await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: bob.account });

    return { admin, alice, bob, carol, referral, engine, bank, betAmount, betData };
}

describe("BRBReferal", function () {
    it("binds referrer on first placeBet and mints BRBR rewards on subsequent bets", async function () {
        const { alice, bob, carol, referral, engine, bank, betAmount, betData } = await deployReferralStack();

        expect(await engine.read.referrerOf([alice.account.address])).to.equal(zeroAddress);

        await bank.write.placeBet([betAmount, betData, bob.account.address], { account: alice.account });
        expect(await engine.read.referrerOf([alice.account.address])).to.equal(getAddress(bob.account.address));
        expect(await referral.read.balanceOf([bob.account.address])).to.equal(betAmount);

        await bank.write.placeBet([betAmount, betData, carol.account.address], { account: alice.account });
        expect(await engine.read.referrerOf([alice.account.address])).to.equal(getAddress(bob.account.address));
        expect(await referral.read.balanceOf([bob.account.address])).to.equal(betAmount * 2n);
        expect(await referral.read.balanceOf([carol.account.address])).to.equal(0n);
    });

    it("reverts self-referral and unauthorized mint", async function () {
        const { alice, bob, referral, bank, betAmount, betData } = await deployReferralStack();

        await expect(
            bank.write.placeBet([betAmount, betData, alice.account.address], { account: alice.account }),
        ).to.be.rejected;
        await expect(
            referral.write.mint([bob.account.address, 1n], { account: alice.account }),
        ).to.be.rejected;
    });
});
