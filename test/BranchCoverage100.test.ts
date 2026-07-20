import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
    decodeAbiParameters,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    parseUnits,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { decodeRoulettePerformData } from "./helpers/decodeUpkeepPerformData";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { laneCheckData } from "./helpers/parallelUpkeep";

const USDC = (v: string) => parseUnits(v, 6);
const GWEI = 1_000_000_000n;

function sideBetConfig(overrides: Record<string, unknown> = {}) {
    return {
        marketId: 1,
        betType: 1,
        color: 0,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

const createMarket = createMarketWithBeacon;

describe("Branch coverage — 100% targets", function () {
    describe("MarketRegistry", function () {
        it("constructor reverts on each zero address", async function () {
            const [admin] = await viem.getWalletClients();
            const engine = admin.account.address;
            const sideBet = admin.account.address;
            await expect(viem.deployContract("MarketRegistry", [zeroAddress, engine, sideBet])).to.be.rejected;
            await expect(viem.deployContract("MarketRegistry", [admin.account.address, zeroAddress, sideBet])).to.be
                .rejected;
            await expect(viem.deployContract("MarketRegistry", [admin.account.address, engine, zeroAddress])).to.be
                .rejected;
        });

        it("setVaultBeacon reverts on zero, empty code, and invalid market reads", async function () {
            const { registry, admin, deployer } = await deployProtocolStack();
            await expect(registry.write.setVaultBeacon([zeroAddress], { account: admin })).to.be.rejected;

            await expect(registry.write.setVaultBeacon([admin], { account: admin })).to.be.rejected;

            await expect(registry.read.getMarket([0])).to.be.rejected;
            await expect(registry.read.getMarket([99])).to.be.rejected;
        });

        it("createMarket reverts when asset, bankAdmin, or minBet is zero", async function () {
            const { registry, admin, deployer } = await deployProtocolStack();
            const vaultImpl = await viem.deployContract("BankVault4626", [], { account: deployer.account });
            const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin], {
                account: deployer.account,
            });
            await registry.write.setVaultBeacon([beacon.address], { account: admin });
            const usdc = await viem.deployContract("MockUSDC");
            await expect(
                registry.write.createMarket([{ asset: zeroAddress, bankAdmin: admin, minBet: 1n }], {
                    account: admin,
                }),
            ).to.be.rejected;
            await expect(
                registry.write.createMarket([{ asset: usdc.address, bankAdmin: zeroAddress, minBet: 1n }], {
                    account: admin,
                }),
            ).to.be.rejected;
            await expect(
                registry.write.createMarket([{ asset: usdc.address, bankAdmin: admin, minBet: 0n }], {
                    account: admin,
                }),
            ).to.be.rejected;
            expect(getAddress(await registry.read.vaultBeacon())).to.equal(getAddress(beacon.address));
        });

        it("happy path createMarket and previewNextMarketId", async function () {
            const { registry, admin } = await deployProtocolStack();
            const usdc = await viem.deployContract("MockUSDC");
            expect(await registry.read.previewNextMarketId()).to.equal(1n);
            const bank = await createMarket(registry, admin, usdc.address);
            expect(await registry.read.marketCount()).to.equal(1n);
            expect(await registry.read.previewNextMarketId()).to.equal(2n);
            const cfg = await registry.read.getMarket([1]);
            expect(getAddress(cfg.bank)).to.equal(getAddress(bank.address));
            expect(getAddress(cfg.asset)).to.equal(getAddress(usdc.address));
            expect(await registry.read.assetToMarket([usdc.address])).to.equal(1n);
        });

        it("createMarket reverts when asset is already registered", async function () {
            const { registry, admin, deployer } = await deployProtocolStack();
            const vaultImpl = await viem.deployContract("BankVault4626", [], { account: deployer.account });
            const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin], {
                account: deployer.account,
            });
            await registry.write.setVaultBeacon([beacon.address], { account: admin });
            const usdc = await viem.deployContract("MockUSDC");
            await createMarket(registry, admin, usdc.address);
            await expect(
                registry.write.createMarket([{ asset: usdc.address, bankAdmin: admin, minBet: 1_000_000n }], {
                    account: admin,
                }),
            ).to.be.rejected;
            expect(await registry.read.marketCount()).to.equal(1n);
        });
    });

    describe("UpkeepScheduler", function () {
        it("constructor reverts on invalid params", async function () {
            const [admin] = await viem.getWalletClients();
            const engine = await viem.deployContract("MockEngine");
            const sideBet = await viem.deployContract("SideBet");
            await expect(
                viem.deployContract("UpkeepScheduler", [zeroAddress, sideBet.address, admin.account.address, 32, 32]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("UpkeepScheduler", [engine.address, sideBet.address, zeroAddress, 32, 32]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("UpkeepScheduler", [engine.address, sideBet.address, admin.account.address, 0, 32]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("UpkeepScheduler", [engine.address, sideBet.address, admin.account.address, 32, 0]),
            ).to.be.rejected;
        });

        it("returns false when lane is at or beyond payoutParallelLaneCount", async function () {
            const { scheduler, engine } = await deployProtocolStack();
            const laneCount = await engine.read.payoutParallelLaneCount();
            const lane = Number(laneCount);
            const checkData = encodeAbiParameters([{ type: "uint256" }], [BigInt(lane)]) as Hex;
            const [needed] = await scheduler.read.checkUpkeep([checkData]);
            expect(needed).to.equal(false);
        });

        it("normalizes laneCount when engine reports zero", async function () {
            const [admin] = await viem.getWalletClients();
            const zeroEngine = await viem.deployContract("MockEngineZeroLanes");
            const { sideBet } = await deployProtocolStack();
            const scheduler = await viem.deployContract("UpkeepScheduler", [
                zeroEngine.address,
                sideBet.address,
                admin.account.address,
                32,
                32,
            ]);
            const [needed] = await scheduler.read.checkUpkeep(["0x"]);
            expect(needed).to.equal(false);
        });

        it("performUpkeep ignores unknown work kind; forwarder gate enforced", async function () {
            const { scheduler, admin } = await deployProtocolStack();
            const authority = await viem.deployContract("CreExecutionAuthority", [admin]);
            await authority.write.setExecutorApproved([admin, true], { account: admin });
            await scheduler.write.setForwarderAuthority([authority.address], { account: admin });

            const invalidKind = encodeAbiParameters([{ type: "uint8" }], [2]) as Hex;
            await scheduler.write.performUpkeep([invalidKind], { account: admin });
            expect(await authority.read.isApprovedAutomationForwarder([admin])).to.equal(true);
        });

        it.skip("falls through to SideBet when payout job has no lane work", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ maxPayoutsPerCall: 10 });
            const { engine, scheduler, sideBet, registry, vrf, brb } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarket(registry, admin.account.address, usdc.address);

            await brb.write.transfer([stack.treasury.address, parseUnits("500", 18)], { account: admin.account });
            await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
            await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
            await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

            const bet = parseUnits("10", 6);
            await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
            await bank.write.placeBet([bet, encodeSingleBet(1n, 7n, bet), zeroAddress], { account: alice.account });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

            while (true) {
                const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
                if (!needed) break;
                const decoded = decodeRoulettePerformData(data);
                if (decoded.jobKind === 2) await scheduler.write.performUpkeep([data]);
                else break;
            }

            await sideBet.write.addConfig([sideBetConfig({ betType: 1, windowSpins: 1 })], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, 1_000_000n, 1_000_000_000n], {
                account: admin.account,
            });
            await sideBet.write.placeBet([configId, parseUnits("10", 6)], { account: alice.account });
            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfill([engine.address, 2n, 8n]);

            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
            expect(needed).to.equal(true);
            expect(Number(decodeAbiParameters([{ type: "uint8" }], performData)[0])).to.equal(1);
        });
    });

    describe("BankVault4626", function () {
        it("initialize guards and side-bet controller paths", async function () {
            const [admin] = await viem.getWalletClients();
            const badToken = await viem.deployContract("MockTokenHighDecimals");
            const mockEngine = await viem.deployContract("MockEngine");
            const impl = await viem.deployContract("BankVault4626");
            const initBad = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: badToken.address,
                        name: "x",
                        symbol: "x",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1n,
                        sideBetController: zeroAddress,
                    },
                ],
            });
            await expect(viem.deployContract("ERC1967Proxy", [impl.address, initBad])).to.be.rejected;

            const initZeroMin = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: (await viem.deployContract("MockUSDC")).address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 0n,
                        sideBetController: admin.account.address,
                    },
                ],
            });
            await expect(viem.deployContract("ERC1967Proxy", [impl.address, initZeroMin])).to.be.rejected;
        });

        it("deposit blocked during resolution", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarket(registry, admin.account.address, usdc.address);

            await usdc.write.mint([admin.account.address, parseUnits("2000", 6)]);
            await usdc.write.approve([bank.address, parseUnits("2000", 6)], { account: admin.account });
            await bank.write.deposit([parseUnits("500", 6), admin.account.address], { account: admin.account });

            await usdc.write.mint([alice.account.address, parseUnits("200", 6)]);
            await usdc.write.approve([bank.address, parseUnits("200", 6)], { account: alice.account });
            await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
                account: alice.account,
            });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await expect(
                bank.write.deposit([parseUnits("20", 6), alice.account.address], { account: alice.account }),
            ).to.be.rejected;

            await vrf.write.fulfill([engine.address, 1n, 7n]);
            expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);
        });

        it("mint and deposit revert when assets too small or resolution blocks", async function () {
            const [admin] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngineRestricted");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: zeroAddress,
                    },
                ],
            });
            const vault = await viem.getContractAt("BankVault4626", (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address);
            const fee = await vault.read.flatWithdrawFee();
            await usdc.write.mint([admin.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: admin.account });
            await expect(vault.write.deposit([fee, admin.account.address], { account: admin.account })).to.be.rejected;
            await expect(vault.write.mint([1n, admin.account.address], { account: admin.account })).to.be.rejected;
        });

        it("lockSideBetStake reverts and releaseBets partial clamp", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: admin.account.address,
                    },
                ],
            });
            const vault = await viem.getContractAt("BankVault4626", (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address);

            await expect(
                vault.write.lockSideBetStake([zeroAddress, 1n, 1n], { account: admin.account }),
            ).to.be.rejected;
            await expect(
                vault.write.lockSideBetStake([alice.account.address, 0n, 1n], { account: admin.account }),
            ).to.be.rejected;

            await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
            await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });
            await vault.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
                account: alice.account,
            });
            await mockEngine.write.releaseFromVault([vault.address, parseUnits("1000", 6)]);
            expect(await vault.read.lockedBetLiquidity()).to.equal(0n);
        });

        it("UnauthorizedSettlementCaller and setSideBetController zero", async function () {
            const [admin, stranger] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: admin.account.address,
                    },
                ],
            });
            const vault = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address,
            );
            await expect(
                vault.write.releaseBets([1n], { account: stranger.account }),
            ).to.be.rejected;
            await expect(vault.write.setSideBetController([zeroAddress], { account: admin.account })).to.be.rejected;
        });

        it("processWithdrawalQueue skips transfer when gross does not exceed fee", async function () {
            const [admin] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [
                    {
                        assetToken: usdc.address,
                        name: "Bank",
                        symbol: "b",
                        marketId: 1,
                        engine: mockEngine.address,
                        admin: admin.account.address,
                        minBet: 1_000_000n,
                        sideBetController: zeroAddress,
                    },
                ],
            });
            const vault = await viem.getContractAt(
                "BankVault4626",
                (await viem.deployContract("ERC1967Proxy", [impl.address, init])).address,
            );
            const fee = await vault.read.flatWithdrawFee();
            await usdc.write.mint([admin.account.address, fee * 2n + 1n]);
            await usdc.write.approve([vault.address, fee * 2n + 1n], { account: admin.account });
            await vault.write.deposit([fee * 2n + 1n, admin.account.address], { account: admin.account });
            await vault.write.redeemBps([1, admin.account.address, admin.account.address], {
                account: admin.account,
            });
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
            expect(await usdc.read.balanceOf([admin.account.address])).to.equal(0n);
        });
    });

    describe("BRBJackpotFunder & JackpotTreasury", function () {
        it("funder constructor zeros, sideBet caller, swap skip, and treasury payBatch zero amounts", async function () {
            const [admin, stranger] = await viem.getWalletClients();
            const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
            const router = await viem.deployContract("MockUniswapV2Router");
            const engine = admin.account.address;
            const sideBetCaller = admin.account.address;

            await expect(
                viem.deployContract("BRBJackpotFunder", [
                    zeroAddress,
                    brb.address,
                    router.address,
                    admin.account.address,
                    sideBetCaller,
                    admin.account.address,
                ]),
            ).to.be.rejected;

            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                engine,
                admin.account.address,
            ]);
            const funder = await viem.deployContract("BRBJackpotFunder", [
                engine,
                brb.address,
                router.address,
                treasury.address,
                sideBetCaller,
                admin.account.address,
            ]);
            const usdc = await viem.deployContract("MockUSDC");

            await expect(
                viem.deployContract("BRBJackpotFunder", [
                    engine,
                    zeroAddress,
                    router.address,
                    treasury.address,
                    sideBetCaller,
                    admin.account.address,
                ]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("BRBJackpotFunder", [
                    engine,
                    brb.address,
                    zeroAddress,
                    treasury.address,
                    sideBetCaller,
                    admin.account.address,
                ]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("BRBJackpotFunder", [
                    engine,
                    brb.address,
                    router.address,
                    zeroAddress,
                    sideBetCaller,
                    admin.account.address,
                ]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("BRBJackpotFunder", [
                    engine,
                    brb.address,
                    router.address,
                    treasury.address,
                    sideBetCaller,
                    zeroAddress,
                ]),
            ).to.be.rejected;

            await expect(funder.write.fundFromMarket([1n, usdc.address], { account: stranger.account })).to.be.rejected;
            await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });

            await router.write.setForceRevertSwap([true]);
            await usdc.write.mint([funder.address, parseUnits("10", 6)]);
            await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });
            await router.write.setForceRevertSwap([false]);

            await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
            await brb.write.setFailTransfer([true]);
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            await brb.write.setFailTransfer([false]);

            await brb.write.transfer([funder.address, parseUnits("5", 18)], { account: admin.account });
            await brb.write.setRevertTransfer([true]);
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            await brb.write.setRevertTransfer([false]);

            await funder.write.setTreasuryBrbSplit([0, 1], { account: admin.account });
            await brb.write.transfer([funder.address, parseUnits("3", 18)], { account: admin.account });
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });

            await brb.write.setFailBurn([true]);
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            await brb.write.setFailBurn([false]);

            await expect(
                treasury.simulate.payBatch([[admin.account.address], [0n]], { account: engine }),
            ).to.be.fulfilled;
        });

        it("JackpotTreasury constructor reverts on zero addresses", async function () {
            const [admin] = await viem.getWalletClients();
            const brb = await viem.deployContract("BRBToken", [admin.account.address]);
            await expect(
                viem.deployContract("JackpotTreasury", [zeroAddress, admin.account.address, admin.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("JackpotTreasury", [brb.address, zeroAddress, admin.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("JackpotTreasury", [brb.address, admin.account.address, zeroAddress]),
            ).to.be.rejected;
        });

        it("fundFromMarket accepts sideBet as fee collector", async function () {
            const [admin] = await viem.getWalletClients();
            const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
            const router = await viem.deployContract("MockUniswapV2Router");
            const treasury = await viem.deployContract("JackpotTreasury", [
                brb.address,
                admin.account.address,
                admin.account.address,
            ]);
            const sideBetAddr = admin.account.address;
            const funder = await viem.deployContract("BRBJackpotFunder", [
                admin.account.address,
                brb.address,
                router.address,
                treasury.address,
                sideBetAddr,
                admin.account.address,
            ]);
            await brb.write.transfer([funder.address, parseUnits("1", 18)], { account: admin.account });
            await funder.write.fundFromMarket([1n, brb.address], { account: sideBetAddr });
        });
    });

    describe("ProtocolTimelock & LPVestingLock", function () {
        it("timelock constructor zeros and cancel on unknown id", async function () {
            const [admin, proposer, executor] = await viem.getWalletClients();
            await expect(
                viem.deployContract("ProtocolTimelock", [zeroAddress, proposer.account.address, executor.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("ProtocolTimelock", [admin.account.address, zeroAddress, executor.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("ProtocolTimelock", [admin.account.address, proposer.account.address, zeroAddress]),
            ).to.be.rejected;

            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            await expect(
                timelock.write.cancel(["0x" + "ab".repeat(32)], { account: admin.account }),
            ).to.be.rejected;

            const callee = await viem.deployContract("MockTimelockCallee");
            const salt = 7n;
            const value = parseUnits("1", 18);
            await timelock.write.queue([callee.address, value, "0x", salt], { account: proposer.account });
            await time.increase(24 * 3600 + 1);
            await expect(
                timelock.write.execute([callee.address, value, "0x", salt], {
                    account: executor.account,
                    value: 0n,
                }),
            ).to.be.rejected;
        });

        it("LPVestingLock constructor and release revert branches", async function () {
            const [admin, beneficiary] = await viem.getWalletClients();
            const lp = await viem.deployContract("MockUSDC");
            await expect(
                viem.deployContract("LPVestingLock", [zeroAddress, beneficiary.account.address, admin.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("LPVestingLock", [lp.address, zeroAddress, admin.account.address]),
            ).to.be.rejected;
            await expect(
                viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, zeroAddress]),
            ).to.be.rejected;

            const lock = await viem.deployContract("LPVestingLock", [
                lp.address,
                beneficiary.account.address,
                admin.account.address,
            ]);
            await lp.write.mint([lock.address, parseUnits("10", 6)]);
            await expect(
                lock.write.release([beneficiary.account.address], { account: beneficiary.account }),
            ).to.be.rejected;
            await time.increase(3 * 365 * 24 * 60 * 60 + 1);
            await expect(
                lock.write.release([zeroAddress, parseUnits("1", 6)], { account: beneficiary.account }),
            ).to.be.rejected;
            await expect(
                lock.write.release([beneficiary.account.address, 0n], { account: beneficiary.account }),
            ).to.be.rejected;
            await expect(
                lock.write.release([beneficiary.account.address, parseUnits("100", 6)], {
                    account: beneficiary.account,
                }),
            ).to.be.rejected;
        });

        it("LPVestingLock release() full balance overload", async function () {
            const [admin, beneficiary] = await viem.getWalletClients();
            const lp = await viem.deployContract("MockUSDC");
            const lock = await viem.deployContract("LPVestingLock", [
                lp.address,
                beneficiary.account.address,
                admin.account.address,
            ]);
            await lp.write.mint([lock.address, parseUnits("5", 6)]);
            await time.increase(3 * 365 * 24 * 60 * 60 + 1);
            await lock.write.release([beneficiary.account.address], { account: beneficiary.account });
            expect(await lp.read.balanceOf([lock.address])).to.equal(0n);
        });
    });

    describe("RouletteEngine", function () {
        afterEach(async function () {
            const testClient = await viem.getTestClient();
            await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
        });

        const itVrfGas = process.env.SOLIDITY_COVERAGE === "true" ? it.skip : it;
        itVrfGas("VRF key hash branches via tx.gasprice tiers", async function () {
            const testClient = await viem.getTestClient();
            const gasTiers = [1n * GWEI, 10n * GWEI, 31n * GWEI] as const;

            for (const gasPrice of gasTiers) {
                const [admin, alice] = await viem.getWalletClients();
                const stack = await deployProtocolStack();
                const { engine, scheduler, registry, vrf, brb, router } = stack;
                const usdc = await viem.deployContract("MockUSDC");
                await brb.write.transfer([router.address, parseUnits("2000000", 18)], { account: admin.account });
                const bank = await createMarket(registry, admin.account.address, usdc.address);

                await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
                await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
                await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

                await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
                await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
                await bank.write.placeBet(
                    [parseUnits("5", 6), encodeSingleBet(1n, 3n, parseUnits("5", 6)), zeroAddress],
                    { account: alice.account },
                );

                await time.increase(550);
                // VRF is requested in the TriggerVrf tx, so set the gas tier before it.
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: gasPrice });
                const [, triggerVrfJob] = await scheduler.read.checkUpkeep(["0x"]);
                await scheduler.write.performUpkeep([triggerVrfJob]);
                expect(await engine.read.hasPendingVrf()).to.equal(true);
                const roundId = await engine.read.currentGlobalRound();
                await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
                await vrf.write.fulfill([engine.address, roundId, 3n]);
                while (true) {
                    const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
                    if (!needed) break;
                    await scheduler.write.performUpkeep([data]);
                }
            }
        });

        it("isBankLiquidityRestricted false when market not in round", async function () {
            const { engine } = await deployProtocolStack();
            expect(await engine.read.isBankLiquidityRestricted([99])).to.equal(false);
        });

        it("onlyRegistry registerMarket and unauthorized scheduler/bank", async function () {
            const [admin, stranger] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, registry } = stack;
            await expect(
                engine.write.registerMarketFromRegistry([1, admin.account.address], { account: stranger.account }),
            ).to.be.rejected;
            await expect(engine.write.setRoundDuration([600], { account: stranger.account })).to.be.rejected;
        });
    });

    describe("SideBet", function () {
        it("initialize reverts on invalid multiplier band", async function () {
            const [admin] = await viem.getWalletClients();
            const impl = await viem.deployContract("SideBet");
            const init = encodeFunctionData({
                abi: impl.abi,
                functionName: "initialize",
                args: [zeroAddress, admin.account.address, admin.account.address, 50_000, 5_000_000],
            });
            await expect(viem.deployContract("ERC1967Proxy", [impl.address, init])).to.be.rejected;
        });
    });
});
