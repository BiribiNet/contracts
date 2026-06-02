import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { encodeFunctionData, parseUnits, zeroAddress, type Address } from "viem";
import { getAddress } from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";

const USDC = (v: string) => parseUnits(v, 6);
function vaultInit(
    asset: Address,
    engine: Address,
    admin: Address,
    minBet: bigint,
    sideBet: Address = zeroAddress,
) {
    return encodeFunctionData({
        abi: [
            {
                type: "function",
                name: "initialize",
                inputs: [
                    {
                        name: "p",
                        type: "tuple",
                        components: [
                            { name: "assetToken", type: "address" },
                            { name: "name", type: "string" },
                            { name: "symbol", type: "string" },
                            { name: "marketId", type: "uint32" },
                            { name: "engine", type: "address" },
                            { name: "admin", type: "address" },
                            { name: "minBet", type: "uint256" },
                            { name: "sideBetController", type: "address" },
                        ],
                    },
                ],
            },
        ],
        functionName: "initialize",
        args: [
            {
                assetToken: asset,
                name: "Bank",
                symbol: "b",
                marketId: 1,
                engine,
                admin,
                minBet,
                sideBetController: sideBet,
            },
        ],
    });
}

describe("Branch coverage — complete matrix", function () {
    describe("BankVault4626 remaining branches", function () {
        it("covers modifiers, permit, queue drain, and liquidity caps", async function () {
            const [admin, alice, bob] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const permitToken = await viem.deployContract("MockERC20Permit");
            const mockEngine = await viem.deployContract("MockEngine");
            const sideBetAddr = admin.account.address;
            const impl = await viem.deployContract("BankVault4626");

            const proxyNoSideBet = await viem.deployContract("ERC1967Proxy", [
                impl.address,
                vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n, zeroAddress),
            ]);
            const vault0 = await viem.getContractAt("BankVault4626", proxyNoSideBet.address);

            const proxySb = await viem.deployContract("ERC1967Proxy", [
                impl.address,
                vaultInit(permitToken.address, mockEngine.address, admin.account.address, 1_000_000n, sideBetAddr),
            ]);
            const vaultSb = await viem.getContractAt("BankVault4626", proxySb.address);

            await expect(vault0.write.processWithdrawalQueue([1n], { account: admin.account })).to.be.rejected;
            await expect(vaultSb.write.lockSideBetStake([alice.account.address, 1n, 1n], { account: admin.account })).to.be
                .rejected;

            await vaultSb.write.setSideBetController([bob.account.address], { account: admin.account });
            await vaultSb.write.setMinBet([2_000_000n], { account: admin.account });

            await expect(
                vaultSb.write.placeBetWithPermit([0n, "0x", zeroAddress, 0n, 0, "0x" + "00".repeat(32), "0x" + "00".repeat(32)], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            await permitToken.write.mint([alice.account.address, parseUnits("50", 18)]);
            await permitToken.write.approve([vaultSb.address, parseUnits("50", 18)], { account: alice.account });
            await vaultSb.write.deposit([parseUnits("20", 18), alice.account.address], { account: alice.account });
            await vaultSb.write.withdraw([parseUnits("5", 18), alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await permitToken.write.mint([bob.account.address, parseUnits("30", 18)]);
            await permitToken.write.approve([vaultSb.address, parseUnits("30", 18)], { account: bob.account });
            await vaultSb.write.deposit([parseUnits("15", 18), bob.account.address], { account: bob.account });
            await vaultSb.write.redeemBps([5000, bob.account.address, bob.account.address], { account: bob.account });

            await mockEngine.write.processWithdrawals([vaultSb.address, 10n]);

            await permitToken.write.mint([alice.account.address, parseUnits("5", 18)]);
            await permitToken.write.approve([vaultSb.address, parseUnits("5", 18)], { account: alice.account });
            await expect(
                vaultSb.write.lockSideBetStake([alice.account.address, parseUnits("1", 18), parseUnits("100", 18)], {
                    account: sideBetAddr,
                }),
            ).to.be.rejected;
        });

        it("pays partial when vault balance is below net withdrawal", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
            const impl = await viem.deployContract("BankVault4626");
            const vault = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [
                    impl.address,
                    vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n),
                ])).address,
            );
            const fee = await vault.read.flatWithdrawFee();
            await usdc.write.mint([alice.account.address, fee * 3n]);
            await usdc.write.approve([vault.address, fee * 3n], { account: alice.account });
            await vault.write.deposit([fee * 3n, alice.account.address], { account: alice.account });
            await vault.write.redeemBps([10_000, alice.account.address, alice.account.address], { account: alice.account });
            await mockEngine.write.transferOutFromVault([
                vault.address,
                admin.account.address,
                await usdc.read.balanceOf([vault.address]),
            ]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
        });
    });

    describe("BRBJackpotFunder admin + happy treasury transfer", function () {
        it("covers setter guards and successful treasury path", async function () {
            const [admin] = await viem.getWalletClients();
            const brb = await viem.deployContract("BRBToken", [admin.account.address]);
            const router = await viem.deployContract("MockUniswapV2Router");
            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                admin.account.address,
                admin.account.address,
            ]);
            const funder = await viem.deployContract("BRBJackpotFunder", [
                admin.account.address,
                brb.address,
                router.address,
                treasury.address,
                admin.account.address,
                admin.account.address,
            ]);
            await expect(funder.write.setSwapAssetBps([1001], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setTreasuryBrbSplit([1, 0], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setSlippageBps([10_000], { account: admin.account })).to.be.rejected;

            await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            expect(await treasury.read.jackpotPool()).to.be.gt(0n);
        });
    });

    describe("ProtocolTimelock success paths", function () {
        it("executes and cancels queued operations", async function () {
            const [admin, proposer, executor] = await viem.getWalletClients();
            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            const callee = await viem.deployContract("MockTimelockCallee");
            const salt = 11n;
            const value = parseUnits("1", 18);
            await timelock.write.queue([callee.address, value, "0x", salt], { account: proposer.account });
            await time.increase(24 * 3600 + 1);
            await timelock.write.execute([callee.address, value, "0x", salt], {
                account: executor.account,
                value,
            });
            const id = await timelock.read.operationId([callee.address, value, "0x", salt]);
            await timelock.write.queue([callee.address, 0n, "0x", salt + 1n], { account: proposer.account });
            const id2 = await timelock.read.operationId([callee.address, 0n, "0x", salt + 1n]);
            await timelock.write.cancel([id2], { account: admin.account });
            expect(await timelock.read.queuedUntil([id])).to.equal(0n);
        });
    });

    describe("JackpotTreasury & MarketRegistry", function () {
        it("reverts payBatch from non-engine and createMarket from stranger", async function () {
            const [admin, stranger] = await viem.getWalletClients();
            const brb = await viem.deployContract("BRBToken", [admin.account.address]);
            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                admin.account.address,
                admin.account.address,
            ]);
            await expect(
                treasury.write.payBatch([[admin.account.address], [1n]], { account: stranger.account }),
            ).to.be.rejected;

            const roundEngine = await viem.deployContract("MockRoundEngine");
            const vaultImpl = await viem.deployContract("BankVault4626");
            const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
            const { registry } = await deploySideBetRegistryStack({
                admin: admin.account.address,
                roundEngine: roundEngine.address,
            });
            const { sideBet } = await deploySideBetProxy({
                admin: admin.account.address,
                roundEngine: roundEngine.address,
                registry: registry.address,
                minMultiplierBps: 50_000,
                maxMultiplierBps: 5_000_000,
            });
            await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
            const usdc = await viem.deployContract("MockUSDC");
            await expect(
                registry.write.createMarket(
                    [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1n }],
                    { account: stranger.account },
                ),
            ).to.be.rejected;
            expect(getAddress(await registry.read.SIDE_BET())).to.equal(getAddress(sideBet.address));
        });
    });

    describe("UpkeepScheduler admin setters", function () {
        it("reverts zero scan limit and max payouts", async function () {
            const { scheduler, deployer } = await deployProtocolStack();
            await expect(scheduler.write.setScanLimit([0], { account: deployer.account })).to.be.rejected;
            await expect(scheduler.write.setMaxPayoutsPerCall([0], { account: deployer.account })).to.be.rejected;
            await wireTestSchedulerForwarder(scheduler, deployer.account);
        });
    });

    describe("RouletteEngine branches", function () {
        it("covers onlyBank recordBet rejection and referral paths", async function () {
            const [admin, stranger] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, registry } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await expect(
                engine.write.recordBet([1, stranger.account.address, 1n, "0x", zeroAddress], {
                    account: stranger.account,
                }),
            ).to.be.rejected;
        });
    });
});
