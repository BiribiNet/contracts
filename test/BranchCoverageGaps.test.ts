import { viem } from "hardhat";

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    parseUnits,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";

import { createMarketWithBeacon } from "./helpers/createMarket";
import { deployProtocolStack } from "./helpers/deployProtocolStack";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { laneCheckData } from "./helpers/parallelUpkeep";

const USDC = (v: string) => parseUnits(v, 6);
const laneKey = () => ("0x" + "11".repeat(32)) as Hex;

describe("Branch coverage — remaining 82 gaps", function () {
    describe("AccessControl revert arms", function () {
        it("reverts privileged calls from unauthorized accounts", async function () {
            const [admin, stranger, beneficiary, proposer, executor] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, sideBet, deployer } = stack;

            await expect(engine.write.setRoundDuration([600], { account: stranger.account })).to.be.rejected;
            await expect(engine.write.setWithdrawalQueueBatchSize([5], { account: stranger.account })).to.be.rejected;
            await expect(engine.write.setMaxWithdrawalQueueLength([100], { account: stranger.account })).to.be.rejected;
            await expect(
                scheduler.write.setForwarderAuthority([stranger.account.address], { account: stranger.account }),
            ).to.be.rejected;
            await expect(scheduler.write.setScanLimit([64], { account: stranger.account })).to.be.rejected;
            await expect(scheduler.write.setMaxPayoutsPerCall([8], { account: stranger.account })).to.be.rejected;
            await expect(scheduler.write.setScanLimit([0], { account: deployer.account })).to.be.rejected;
            await expect(scheduler.write.setMaxPayoutsPerCall([0], { account: deployer.account })).to.be.rejected;

            const link = await viem.deployContract("MockLinkToken");
            const registrar = await viem.deployContract("MockKeeperRegistry");
            const manager = await viem.deployContract("UpkeepManager", [
                link.address,
                registrar.address,
                registrar.address,
                admin.account.address,
                admin.account.address,
                admin.account.address,
            ]);
            await expect(
                manager.write.registerLaneUpkeep([0n, 400_000, parseUnits("1", 18), admin.account.address], {
                    account: stranger.account,
                }),
            ).to.be.rejected;

            const lp = await viem.deployContract("MockUSDC");
            const lock = await viem.deployContract("LPVestingLock", [
                lp.address,
                beneficiary.account.address,
                admin.account.address,
            ]);
            await expect(lock.write.release([beneficiary.account.address], { account: stranger.account })).to.be.rejected;
            await expect(
                lock.write.release([beneficiary.account.address, USDC("1")], { account: stranger.account }),
            ).to.be.rejected;

            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            const callee = await viem.deployContract("MockTimelockCallee");
            await timelock.write.queue([callee.address, 0n, "0x", 1n], { account: proposer.account });
            await expect(
                timelock.write.execute([callee.address, 0n, "0x", 1n], { account: stranger.account }),
            ).to.be.rejected;
            await expect(timelock.write.cancel([("0x" + "aa".repeat(32)) as Hex], { account: stranger.account })).to.be
                .rejected;

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
            await expect(funder.write.setTreasuryBrbSplit([2, 1], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setTreasuryBrbSplit([1, 0], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setSlippageBps([10_000], { account: admin.account })).to.be.rejected;
            await expect(funder.write.setSwapAssetBps([300], { account: stranger.account })).to.be.rejected;
            await expect(funder.write.setTreasuryBrbSplit([250, 300], { account: stranger.account })).to.be.rejected;
            await expect(funder.write.setSlippageBps([100], { account: stranger.account })).to.be.rejected;

            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await expect(bank.write.setSideBetController([zeroAddress], { account: admin.account })).to.be.rejected;
            await expect(bank.write.setMinBet([0n], { account: admin.account })).to.be.rejected;

            await expect(sideBet.write.updateConfig([0n, sideBetCfg()], { account: stranger.account })).to.be.rejected;
            await expect(
                sideBet.write.setMultiplierBand([60_000, 4_000_000], { account: stranger.account }),
            ).to.be.rejected;
            await expect(sideBet.write.placeBet([0n, USDC("1")], { account: stranger.account })).to.be.rejected;

            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await expect(
                sideBet.write.settleBatch([[{ betId: 0n, won: false, payoutAmount: 0n }], []], {
                    account: stranger.account,
                }),
            ).to.be.rejected;

            const v2 = await viem.deployContract("SideBet");
            await expect(sideBet.write.upgradeToAndCall([v2.address, "0x"], { account: stranger.account })).to.be
                .rejected;

            const v2Engine = await viem.deployContract(
                "RouletteEngine",
                [stack.vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await expect(engine.write.upgradeToAndCall([v2Engine.address, "0x"], { account: stranger.account })).to.be
                .rejected;
        });
    });

    describe("RouletteEngine storage and lock/VRF revert paths", function () {
        it("covers zero lane count, invalid bet sum, and scheduler lock guards", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, router, deployer } = stack;
            const testClient = await viem.getTestClient();

            const harnessImpl = await viem.deployContract(
                "RouletteEngineHarness",
                [vrf.address, laneKey(), laneKey(), laneKey(), 1, zeroAddress],
                { libraries: await deployEngineLibs() },
            );
            await engine.write.upgradeToAndCall([harnessImpl.address, "0x"], { account: deployer.account });
            const harness = await viem.getContractAt("RouletteEngineHarness", engine.address);
            await harness.write.harnessSetPayoutLaneCount([0]);
            expect(await harness.read.payoutParallelLaneCount()).to.equal(1n);

            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([router.address, parseUnits("1000000", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([bank.address, USDC("100")], { account: alice.account });

            const mismatchedSum = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[1n], [7n], [USDC("6")]],
            );
            await expect(
                bank.write.placeBet([USDC("5"), mismatchedSum, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            const emptyPayload = encodeAbiParameters(
                [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
                [[], [], []],
            );
            await expect(
                bank.write.placeBet([USDC("5"), emptyPayload, zeroAddress], { account: alice.account }),
            ).to.be.rejected;

            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            await testClient.impersonateAccount({ address: scheduler.address });
            await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });

            const preLock = {
                kind: 1,
                marketId: 0,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 10,
            };
            await time.increase(550);
            await engine.write.executeJob([preLock, [], [], []], { account: scheduler.address });
            await engine.write.executeJob([preLock, [], [], []], { account: scheduler.address });

            const trigger = { kind: 2, marketId: 0, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 };
            await engine.write.executeJob([trigger, [], [], []], { account: scheduler.address });
            await engine.write.executeJob([trigger, [], [], []], { account: scheduler.address });

            await testClient.stopImpersonatingAccount({ address: scheduler.address });
        });

        it("findNextJob skips preLock until trigger market and lockAt", async function () {
            const [admin] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf, brb, router } = stack;

            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(false);

            await brb.write.transfer([router.address, parseUnits("1000000", 18)], { account: admin.account });
            const usdc = await viem.deployContract("MockUSDC");
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("1000"), admin.account.address], { account: admin.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: admin.account,
            });

            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(false);

            await time.increase(550);
            expect((await engine.read.findNextJob([0, 25, 0, 0]))[0]).to.equal(true);

            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfill([engine.address, 1n, 7n]);
        });

        it("covers preview guards, losing round jackpot skip, and finalize idempotency", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack({ deployBrbReferral: true });
            const { engine, scheduler, registry, vrf, brb, treasury } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            await brb.write.transfer([treasury.address, parseUnits("100", 18)], { account: admin.account });
            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);

            await usdc.write.mint([admin.account.address, USDC("5000")]);
            await usdc.write.approve([bank.address, USDC("5000")], { account: admin.account });
            await bank.write.deposit([USDC("2000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(8n, 0n, USDC("10")), zeroAddress], {
                account: alice.account,
            });

            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

            const payoutJob = {
                kind: 3,
                marketId: 1,
                roundId: 1n,
                nextCursor: 0,
                payoutShardIndex: 0,
                payoutShardWidth: 1,
            };
            expect(await engine.read.previewPayoutBundle([payoutJob, 0])).to.satisfy(
                (r: readonly [unknown[]]) => r[0].length === 0,
            );
            expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(true);

            while (await engine.read.payoutLaneHasWork([payoutJob])) {
                const preview = await engine.read.previewPayoutBundle([payoutJob, 1]);
                await scheduler.write.performUpkeep([
                    encodePerformData(payoutJob, preview[0], preview[1], preview[2]),
                ]);
            }
        });
    });

    describe("BankVault4626 liquidity caps and withdrawal queue", function () {
        it("caps maxWithdraw/maxRedeem and pays partial queue when balance is thin", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const mockEngine = await viem.deployContract("MockEngine");
            const usdc = await viem.deployContract("MockUSDC");
            const impl = await viem.deployContract("BankVault4626");
            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        impl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n),
                    ])
                ).address,
            );

            await usdc.write.mint([alice.account.address, USDC("200")]);
            await usdc.write.approve([vault.address, USDC("200")], { account: alice.account });
            await vault.write.deposit([USDC("100"), alice.account.address], { account: alice.account });
            await vault.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await mockEngine.write.transferOutFromVault([vault.address, admin.account.address, USDC("95")]);

            const mw = await vault.read.maxWithdraw([alice.account.address]);
            expect(mw).to.be.lte(USDC("10"));
            const mr = await vault.read.maxRedeem([alice.account.address]);
            expect(mr).to.be.gt(0n);

            await vault.write.redeemBps([5000, alice.account.address, alice.account.address], {
                account: alice.account,
            });
            await mockEngine.write.transferOutFromVault([
                vault.address,
                admin.account.address,
                (await usdc.read.balanceOf([vault.address])) - (await vault.read.flatWithdrawFee()),
            ]);
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
        });

        it("blocks mint during resolution and covers initialize sideBet emit", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const stack = await deployProtocolStack();
            const { engine, scheduler, registry, vrf } = stack;
            const usdc = await viem.deployContract("MockUSDC");
            const sideBetAddr = alice.account.address;
            const mockEngine = await viem.deployContract("MockEngine");
            const impl = await viem.deployContract("BankVault4626");
            const vault = await viem.getContractAt(
                "BankVault4626",
                (
                    await viem.deployContract("ERC1967Proxy", [
                        impl.address,
                        vaultInit(usdc.address, mockEngine.address, admin.account.address, 1_000_000n, sideBetAddr),
                    ])
                ).address,
            );
            expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(sideBetAddr));

            const bank = await createMarketWithBeacon(registry, admin.account.address, usdc.address);
            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await bank.write.placeBet([USDC("10"), encodeSingleBet(1n, 7n, USDC("10")), zeroAddress], {
                account: alice.account,
            });
            await time.increase(550);
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await expect(
                bank.write.mint([USDC("10"), alice.account.address], { account: alice.account }),
            ).to.be.rejected;
            await scheduler.write.performUpkeep([(await scheduler.read.checkUpkeep(["0x"]))[1]]);
            await vrf.write.fulfill([engine.address, 1n, 7n]);
        });
    });

    describe("BRBJackpotFunder toBurn == 0 path", function () {
        it("funds treasury only when split sends all BRB to jackpot", async function () {
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
            await funder.write.setTreasuryBrbSplit([1000, 1000], { account: admin.account });
            await brb.write.transfer([funder.address, parseUnits("10", 18)], { account: admin.account });
            const supplyBefore = await brb.read.totalSupply();
            await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
            expect(await treasury.read.jackpotPool()).to.be.gt(0n);
            expect(await brb.read.totalSupply()).to.equal(supplyBefore);
        });
    });

    describe("SideBet settle row and preview branches", function () {
        it("covers lost-row payout guard and undecided active bets in preview", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
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
            await registry.write.createMarket(
                [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
                { account: admin.account },
            );
            const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });

            await sideBet.write.addConfig([sideBetCfg({ windowSpins: 5 })], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });

            const undecided = await sideBet.read.previewSettleBundle([0n, 10, 0, 1]);
            expect(undecided[0].length).to.equal(0);

            await roundEngine.write.fulfillRounds([[8]]);
            const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
            await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
            const before = await sideBet.read.getBet([0n]);
            await sideBet.write.settleBatch([[{ betId: 0n, won: false, payoutAmount: 1n }], []], {
                account: admin.account,
            });
            expect((await sideBet.read.getBet([0n])).status).to.equal(before.status);
        });
    });

    describe("UpkeepScheduler SideBet performUpkeep", function () {
        it("runs SideBet branch in performUpkeep", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
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
            await registry.write.createMarket(
                [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
                { account: admin.account },
            );
            const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
            const scheduler = await viem.deployContract("UpkeepScheduler", [
                roundEngine.address,
                sideBet.address,
                admin.account.address,
                32,
                32,
            ]);
            await sideBet.write.grantRole([await sideBet.read.SETTLEMENT_ROLE(), scheduler.address], {
                account: admin.account,
            });
            await usdc.write.mint([admin.account.address, USDC("10000")]);
            await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
            await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("1000")], { account: admin.account });
            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            await roundEngine.write.fulfillRounds([[8]]);
            const [, data] = await scheduler.read.checkUpkeep(["0x"]);
            await scheduler.write.performUpkeep([data]);
        });
    });

    describe("ProtocolTimelock revert matrix", function () {
        it("covers queue, execute, and cancel validation branches", async function () {
            const [admin, stranger, proposer, executor] = await viem.getWalletClients();
            const timelock = await viem.deployContract("ProtocolTimelock", [
                admin.account.address,
                proposer.account.address,
                executor.account.address,
            ]);
            const callee = await viem.deployContract("MockTimelockCallee");
            const salt = 42n;

            await expect(
                timelock.write.queue([callee.address, 0n, "0x", salt], { account: stranger.account }),
            ).to.be.rejected;
            await timelock.write.queue([callee.address, 0n, "0x", salt], { account: proposer.account });
            await expect(
                timelock.write.queue([callee.address, 0n, "0x", salt], { account: proposer.account }),
            ).to.be.rejected;

            await expect(
                timelock.write.execute([callee.address, 0n, "0x", salt + 1n], { account: executor.account }),
            ).to.be.rejected;
            await timelock.write.queue([callee.address, 0n, "0x", salt + 1n], { account: proposer.account });
            await expect(
                timelock.write.execute([callee.address, 0n, "0x", salt + 1n], { account: executor.account }),
            ).to.be.rejected;

            await time.increase(24 * 3600 + 1);
            await timelock.write.execute([callee.address, 0n, "0x", salt], { account: executor.account });
            await expect(timelock.write.cancel([("0x" + "bb".repeat(32)) as Hex], { account: admin.account })).to.be
                .rejected;
        });
    });

    describe("SideBet views and admin happy paths", function () {
        it("covers availableVaultLiquidity, player bet views, and config admin success", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const fixture = await deploySideBetFixture(admin);
            const { sideBet, bank, usdc } = fixture;

            expect(await sideBet.read.availableVaultLiquidity([1])).to.be.gt(0n);
            await sideBet.write.addConfig([sideBetCfg()], { account: admin.account });
            const configId = (await sideBet.read.configCount()) - 1n;
            await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });
            await sideBet.write.updateConfig([configId, sideBetCfg({ targetNumber: 8 })], { account: admin.account });
            await sideBet.write.setMultiplierBand([60_000, 4_000_000], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("50")]);
            await usdc.write.approve([bank.address, USDC("50")], { account: alice.account });
            await sideBet.write.placeBet([configId, USDC("10")], { account: alice.account });
            expect(await sideBet.read.playerBetCount([alice.account.address])).to.equal(1n);
            expect(await sideBet.read.playerBetAt([alice.account.address, 0n])).to.equal(0n);
        });
    });

    describe("BankVault4626 remaining guards", function () {
        it("covers initialize minBet, sideBet liquidity, setMinBet success, and fee-skipping queue", async function () {
            const [admin, alice] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC");
            const mockEngine = await viem.deployContract("MockEngine");
            const impl = await viem.deployContract("BankVault4626");

            await expect(
                viem.deployContract("ERC1967Proxy", [
                    impl.address,
                    vaultInit(usdc.address, mockEngine.address, admin.account.address, 0n),
                ]),
            ).to.be.rejected;

            const initWithSideBet = encodeFunctionData({
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
                (await viem.deployContract("ERC1967Proxy", [impl.address, initWithSideBet])).address,
            );
            await vault.write.setSideBetController([alice.account.address], { account: admin.account });
            await vault.write.setMinBet([2_000_000n], { account: admin.account });

            await usdc.write.mint([alice.account.address, USDC("100")]);
            await usdc.write.approve([vault.address, USDC("100")], { account: alice.account });
            await vault.write.deposit([USDC("50"), alice.account.address], { account: alice.account });
            await expect(
                vault.write.lockSideBetStake([alice.account.address, USDC("10"), USDC("1000")], {
                    account: alice.account,
                }),
            ).to.be.rejected;

            const fee = await vault.read.flatWithdrawFee();
            await vault.write.redeemBps([100, alice.account.address, alice.account.address], { account: alice.account });
            await mockEngine.write.processWithdrawals([vault.address, 1n]);
            expect(fee).to.be.gt(0n);
        });
    });
});

function sideBetCfg(overrides: Record<string, unknown> = {}) {
    return {
        marketId: 1,
        betType: 1,
        color: 0,
        targetNumber: 7,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 1,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

function vaultInit(asset: Address, engine: Address, admin: Address, minBet: bigint, sideBet: Address = zeroAddress) {
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

function encodePerformData(
    job: {
        kind: number;
        marketId: number;
        roundId: bigint;
        nextCursor: number;
        payoutShardIndex: number;
        payoutShardWidth: number;
    },
    vaultPayouts: unknown[],
    jackpotWinners: unknown[],
    jackpotAmounts: unknown[],
) {
    return encodeAbiParameters(
        [
            { type: "uint8" },
            { type: "uint256" },
            {
                type: "tuple",
                components: [
                    { name: "kind", type: "uint8" },
                    { name: "marketId", type: "uint32" },
                    { name: "roundId", type: "uint64" },
                    { name: "nextCursor", type: "uint32" },
                    { name: "payoutShardIndex", type: "uint32" },
                    { name: "payoutShardWidth", type: "uint32" },
                ],
            },
            { type: "tuple[]", components: [{ name: "player", type: "address" }, { name: "amount", type: "uint256" }] },
            { type: "address[]" },
            { type: "uint256[]" },
        ],
        [0, 0n, job, vaultPayouts, jackpotWinners, jackpotAmounts],
    );
}

async function deploySideBetFixture(admin: Awaited<ReturnType<typeof viem.getWalletClients>>[0]) {
    const usdc = await viem.deployContract("MockUSDC");
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
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
        { account: admin.account },
    );
    const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    await usdc.write.mint([admin.account.address, USDC("10000")]);
    await usdc.write.approve([bank.address, USDC("10000")], { account: admin.account });
    await bank.write.deposit([USDC("5000"), admin.account.address], { account: admin.account });
    return { usdc, sideBet, bank, roundEngine };
}

async function deployEngineLibs() {
    const rouletteBetLib = await viem.deployContract("RouletteBetLib");
    const rouletteLib = await viem.deployContract("RouletteLib");
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib");
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib");
    const rouletteExposureLib = await viem.deployContract("RouletteExposureLib");
    const rouletteUpkeepScanLib = await viem.deployContract("RouletteUpkeepScanLib");
    const rouletteJackpotCollectLib = await viem.deployContract("RouletteJackpotCollectLib");
    const roulettePayoutSweepLib = await viem.deployContract("RoulettePayoutSweepLib", [], {
        libraries: {
            "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": rouletteBetLib.address,
            "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib": roulettePayoutMulLib.address,
        },
    });
    const rouletteLiabilityMathLib = await viem.deployContract("RouletteLiabilityMathLib", [], {
        libraries: { "contracts/RouletteLib.sol:RouletteLib": rouletteLib.address },
    });
    const rouletteBetCodecLib = await viem.deployContract("RouletteBetCodecLib", [], {
        libraries: { "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": rouletteBetLib.address },
    });
    return {
        "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": jackpotBatchLib.address,
        "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib": rouletteBetCodecLib.address,
        "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib": rouletteLiabilityMathLib.address,
        "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": roulettePayoutSweepLib.address,
        "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib": rouletteJackpotCollectLib.address,
        "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib": rouletteExposureLib.address,
        "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib": rouletteUpkeepScanLib.address,
    };
}
