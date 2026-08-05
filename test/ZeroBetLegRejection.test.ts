import { viem } from "hardhat";

import { expect } from "chai";
import { parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { marketLimitsUsdc6 } from "./helpers/marketLimits";
import { encodeMultiBet } from "./helpers/multiBetEncode";

const MIN_BET = marketLimitsUsdc6.minBet;
const STRAIGHT = 1n;

async function deployFixture() {
    const [admin, alice] = await viem.getWalletClients();

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
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: MIN_BET }],
        { account: admin.account },
    );

    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    const lpDeposit = parseUnits("20000", 6);
    await usdc.write.mint([admin.account.address, lpDeposit]);
    await usdc.write.approve([bank.address, lpDeposit], { account: admin.account });
    await bank.write.deposit([lpDeposit, admin.account.address], { account: admin.account });

    const playerFunds = parseUnits("500", 6);
    await usdc.write.mint([alice.account.address, playerFunds]);
    await usdc.write.approve([bank.address, playerFunds], { account: alice.account });

    return { alice, bank, engine };
}

describe("Zero-amount bet leg rejection (C-5)", function () {
    it("accepts a multi-leg bet where every leg carries a positive stake", async function () {
        const { alice, bank } = await deployFixture();
        const legs = [
            { betType: STRAIGHT, number: 5n, amount: MIN_BET },
            { betType: STRAIGHT, number: 7n, amount: MIN_BET },
        ];
        const total = MIN_BET * 2n;
        await bank.write.placeBet([total, encodeMultiBet(legs), zeroAddress], { account: alice.account });
        expect(await bank.read.lockedBetLiquidity()).to.equal(total);
    });

    it("rejects a bet whose individual leg has a zero stake even when the aggregate meets minBet", async function () {
        const { alice, bank } = await deployFixture();
        // Aggregate == minBet (passes the bank's aggregate check), but one straight leg is dust (0).
        const legs = [
            { betType: STRAIGHT, number: 5n, amount: MIN_BET },
            { betType: STRAIGHT, number: 7n, amount: 0n },
        ];
        await expect(
            bank.write.placeBet([MIN_BET, encodeMultiBet(legs), zeroAddress], { account: alice.account }),
        ).to.be.rejected;
    });

    it("rejects the 37-number dust jackpot-ticket payload", async function () {
        const { alice, bank } = await deployFixture();
        // The classic exploit shape: one real outside leg covering minBet, plus 37 straight
        // legs at 1 wei... except here we assert the zero-leg variant is refused outright.
        const legs = [{ betType: 8n, number: 0n, amount: MIN_BET }];
        for (let n = 0; n < 37; n++) {
            legs.push({ betType: STRAIGHT, number: BigInt(n), amount: 0n });
        }
        await expect(
            bank.write.placeBet([MIN_BET, encodeMultiBet(legs), zeroAddress], { account: alice.account }),
        ).to.be.rejected;
    });
});
