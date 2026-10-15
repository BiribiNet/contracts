import { viem } from "hardhat";

import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { marketLimitsUsdc6 } from "./helpers/marketLimits";
import { distinctRouletteLegs, encodeMultiBet, straightLegs } from "./helpers/multiBetEncode";

const STAKE_PER_LEG = marketLimitsUsdc6.minBet;
const STRAIGHT = 1n;

async function deployBetCostFixture() {
    const [admin, alice] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    const usdc = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const mockRouter = await viem.deployContract("MockUniswapV2Router");
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, registry } = await deployRouletteEngine(
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
        { admin: admin.account.address, scanLimit: 5, maxPayoutsPerCall: 25 },
        {
            protocolPrefix: {
                brb: brb.address,
                mockRouter: mockRouter.address,
                admin: admin.account.address,
            },
        },
    );

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: marketLimitsUsdc6.minBet }],
        { account: admin.account },
    );

    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    const lpDeposit = parseUnits("20000", 6);
    await usdc.write.mint([admin.account.address, lpDeposit]);
    await usdc.write.approve([bank.address, lpDeposit], { account: admin.account });
    await bank.write.deposit([lpDeposit, admin.account.address], { account: admin.account });

    return { publicClient, alice, usdc, bank, engine };
}

describe("Multi-bet placeBet cost", function () {
    it("charges 30× minBet and places 30 straight legs in one tx", async function () {
        const legCount = 30;
        const { publicClient, alice, usdc, bank } = await deployBetCostFixture();

        const legs = straightLegs(legCount, STAKE_PER_LEG);
        const totalStake = STAKE_PER_LEG * BigInt(legCount);
        const betData = encodeMultiBet(legs);

        const playerFunds = parseUnits("500", 6);
        await usdc.write.mint([alice.account.address, playerFunds]);
        await usdc.write.approve([bank.address, playerFunds], { account: alice.account });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        const gas = await publicClient.estimateContractGas({
            address: bank.address,
            abi: bank.abi,
            functionName: "placeBet",
            args: [totalStake, betData, zeroAddress],
            account: alice.account,
        });

        await bank.write.placeBet([totalStake, betData, zeroAddress], { account: alice.account });

        const balanceAfter = await usdc.read.balanceOf([alice.account.address]);
        expect(totalStake).to.equal(parseUnits("30", 6));
        expect(balanceBefore - balanceAfter).to.equal(totalStake);
        expect(await bank.read.lockedBetLiquidity()).to.equal(totalStake);
        expect(legs).to.have.length(legCount);
        expect(legs.every((l) => l.betType === STRAIGHT)).to.equal(true);

        // Hardhat estimate (~3.31M); execution ~3.20M (see gas reporter).
        expect(gas).to.be.gte(3_200_000n);
        expect(gas).to.be.lt(3_500_000n);
    });

    it("charges 50× minBet and places 50 distinct legs in one tx", async function () {
        const legCount = 50;
        const { publicClient, alice, usdc, bank } = await deployBetCostFixture();

        const legs = distinctRouletteLegs(legCount, STAKE_PER_LEG);
        const totalStake = STAKE_PER_LEG * BigInt(legCount);
        const betData = encodeMultiBet(legs);

        const playerFunds = parseUnits("500", 6);
        await usdc.write.mint([alice.account.address, playerFunds]);
        await usdc.write.approve([bank.address, playerFunds], { account: alice.account });

        const balanceBefore = await usdc.read.balanceOf([alice.account.address]);
        const gas = await publicClient.estimateContractGas({
            address: bank.address,
            abi: bank.abi,
            functionName: "placeBet",
            args: [totalStake, betData, zeroAddress],
            account: alice.account,
        });

        await bank.write.placeBet([totalStake, betData, zeroAddress], { account: alice.account });

        const balanceAfter = await usdc.read.balanceOf([alice.account.address]);
        expect(totalStake).to.equal(parseUnits("50", 6));
        expect(balanceBefore - balanceAfter).to.equal(totalStake);
        expect(await bank.read.lockedBetLiquidity()).to.equal(totalStake);
        expect(legs).to.have.length(legCount);

        expect(gas).to.be.gte(5_000_000n);
        // Coverage instrumentation adds ~5–10% overhead.
        const gasUpperBound = process.env.SOLIDITY_COVERAGE === "true" ? 6_000_000n : 5_500_000n;
        expect(gas).to.be.lt(gasUpperBound);
    });
});
