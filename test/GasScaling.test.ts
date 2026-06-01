import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

// Profiler: REPORT_GAS=1 yarn test test/GasScaling.test.ts — sanity-check upkeep path gas (scheduler + engine hotspots).
describe("Gas scaling guards", function () {
    it("keeps scheduler performUpkeep gas bounded for many markets", async function () {
        const marketCount = 25;
        const [admin, alice] = await viem.getWalletClients();
        const publicClient = await viem.getPublicClient();

        const assets = [];
        for (let i = 0; i < marketCount; i++) {
            assets.push(await viem.deployContract("MockUSDC"));
        }
        const vrf = await viem.deployContract("MockVrfCoordinator");

        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const mockRouter = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler, registry } = await deployRouletteEngine(
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
            },
        );

        for (let i = 0; i < marketCount; i++) {
        }

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });

        for (let i = 0; i < marketCount; i++) {
            await registry.write.createMarket(
                [
                    {
                        asset: assets[i].address,
                        bankAdmin: admin.account.address,

                minBet: 1_000_000n,
                    },
                ],
                { account: admin.account },
            );
        }

        expect(await engine.read.currentGlobalRound()).to.equal(1n);

        // Place one bet in market 1 to start the lock timer.
        const cfg1 = await registry.read.getMarket([1]);
        const bank1 = await viem.getContractAt("BankVault4626", cfg1.bank);
        // LP liquidity so buffered max-liability fits a straight (36× payout + 110% buffer).
        await assets[0].write.mint([admin.account.address, parseUnits("20000", 6)]);
        await assets[0].write.approve([bank1.address, parseUnits("20000", 6)], { account: admin.account });
        await bank1.write.deposit([parseUnits("5000", 6), admin.account.address], { account: admin.account });
        await assets[0].write.mint([alice.account.address, parseUnits("1000", 6)]);
        await assets[0].write.approve([bank1.address, parseUnits("1000", 6)], { account: alice.account });
        await bank1.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], { account: alice.account });

        await time.increase(550);

        // PreLock should still be bounded.
        const [preLockNeeded, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(preLockNeeded).to.equal(true);
        const preLockGas = await publicClient.estimateContractGas({
            address: scheduler.address,
            abi: scheduler.abi,
            functionName: "performUpkeep",
            args: [preLockData],
            account: admin.account,
        });
        expect(preLockGas).to.be.lt(2_500_000n);
    });
});

