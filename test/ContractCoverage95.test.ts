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

import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";

import { decodeRoulettePerformData } from "./helpers/decodeUpkeepPerformData";
import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { wireTestSchedulerForwarder } from "./helpers/wireTestSchedulerForwarder";
import { laneCheckData } from "./helpers/parallelUpkeep";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

function vaultInitData(
    asset: Address,
    engine: Address,
    admin: Address,
    minBet: bigint,
    sideBetController: Address = "0x0000000000000000000000000000000000000000",
): Hex {
    return encodeFunctionData({
        abi: [
            {
                type: "function",
                name: "initialize",
                stateMutability: "nonpayable",
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
                outputs: [],
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
                sideBetController,
            },
        ],
    });
}

async function deployEngineStack() {
    const [admin, alice, bob] = await viem.getWalletClients();
    const usdc = await viem.deployContract("MockUSDC");
    const vrf = await viem.deployContract("MockVrfCoordinator");
    const brb = await viem.deployContract("BRBToken", [admin.account.address]);
    const router = await viem.deployContract("MockUniswapV2Router");
    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler, sideBet, jackpotTreasury: treasury, funder, registry } = await deployRouletteEngine(
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
                mockRouter: router.address,
                admin: admin.account.address,
            },
        },
    );

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
        { account: admin.account },
    );
    const cfg = await registry.read.getMarket([1]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);

    return { admin, alice, bob, usdc, vrf, brb, treasury, funder, registry, engine, scheduler, sideBet, bank };
}

async function deployMockSideBetMarketStack(admin: { account: { address: Address } }) {
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
    return { usdc, roundEngine, registry, sideBet, bank };
}

async function registerSideBetNumberHit(
    sideBet: Awaited<ReturnType<typeof deployEngineStack>>["sideBet"],
    admin: { address: `0x${string}` },
    windowSpins = 1,
) {
    await sideBet.write.addConfig(
        [
            {
                marketId: 1,
                betType: 1,
                color: 0,
                targetNumber: 7,
                targetCount: 1,
                redRatioBps: 0,
                windowSpins,
                multiplierBps: 100_000,
                minStake: 0n,
                maxStake: 0n,
            },
        ],
        { account: admin },
    );
    const configId = (await sideBet.read.configCount()) - 1n;
    await sideBet.write.setConfigStakeLimits([configId, 1_000_000n, 1_000_000_000n], { account: admin });
    return configId;
}

describe("Contract coverage — 95% targets", function () {
    it("covers RouletteEngine storage getters and admin setters", async function () {
        const { admin, registry, engine, treasury, funder, vrf, scheduler } = await deployEngineStack();

        expect(getAddress(await engine.read.REGISTRY())).to.equal(getAddress(registry.address));
        expect(getAddress(await engine.read.JACKPOT_TREASURY())).to.equal(getAddress(treasury.address));
        expect(getAddress(await engine.read.JACKPOT_FUNDER())).to.equal(getAddress(funder.address));
        expect(await engine.read.VRF_SUBSCRIPTION_ID()).to.equal(1n);
        expect(await engine.read.VRF_KEY_HASH_2_GWEI()).to.not.equal("0x" + "0".repeat(64));
        expect(await engine.read.VRF_KEY_HASH_30_GWEI()).to.not.equal("0x" + "0".repeat(64));
        expect(await engine.read.VRF_KEY_HASH_150_GWEI()).to.not.equal("0x" + "0".repeat(64));
        expect(await engine.read.VRF_CALLBACK_GAS_LIMIT()).to.equal(2_000_000n);
        expect(await engine.read.VRF_CONFIRMATIONS()).to.equal(1);
        expect(await engine.read.ROUND_DURATION()).to.equal(500);
        expect(await engine.read.withdrawalQueueBatchSize()).to.be.gt(0n);
        expect(await engine.read.maxWithdrawalQueueLength()).to.be.gt(0n);
        expect(getAddress(await engine.read.INFRA_RECIPIENT())).to.equal(getAddress(admin.account.address));
        expect(await engine.read.INFRA_BPS()).to.equal(200n);
        expect(getAddress(await engine.read.UPKEEP_SCHEDULER())).to.equal(getAddress(scheduler.address));
        expect(await engine.read.hasPendingVrf()).to.equal(false);
        expect(await engine.read.vrfActiveRound()).to.equal(0n);

        await engine.write.setWithdrawalQueueBatchSize([5], { account: admin.account });
        expect(await engine.read.withdrawalQueueBatchSize()).to.equal(5n);
        await engine.write.setMaxWithdrawalQueueLength([100], { account: admin.account });
        expect(await engine.read.maxWithdrawalQueueLength()).to.equal(100n);

        const [fulfilled, winningNumber] = await engine.read.roundOutcome([1n]);
        expect(fulfilled).to.equal(false);
        expect(winningNumber).to.equal(0);

        const [vrfOk, jackpotTriggered] = await engine.read.roundJackpotTriggered([1n]);
        expect(vrfOk).to.equal(false);
        expect(jackpotTriggered).to.equal(false);
    });

    it("covers isBankLiquidityRestricted during locked rounds", async function () {
        const { admin, alice, usdc, engine, scheduler, bank } = await deployEngineStack();

        await usdc.write.mint([admin.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("1000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("500", 6), admin.account.address], { account: admin.account });

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(false);
        await time.increase(550);
        const [, preLock] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLock]);
        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);
        await expect(
            bank.write.deposit([parseUnits("20", 6), alice.account.address], { account: alice.account }),
        ).to.be.rejected;
    });

    it("covers findNextJob / previewPayoutBundle / payoutLaneHasWork edge paths", async function () {
        const { engine } = await deployEngineStack();

        const [foundShard, jobShard] = await engine.read.findNextJob([0, 10, 0, 1]);
        expect(foundShard).to.equal(false);

        const badJob = {
            kind: 3,
            marketId: 1,
            roundId: 1n,
            nextCursor: 0,
            payoutShardIndex: 99,
            payoutShardWidth: 10,
        };
        expect(await engine.read.payoutLaneHasWork([badJob])).to.equal(false);

        const emptyPreview = await engine.read.previewPayoutBundle([
            { kind: 0, marketId: 0, roundId: 0n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 0 },
            10,
        ]);
        expect(emptyPreview[0].length).to.equal(0);

        const zeroShardPreview = await engine.read.previewPayoutBundle([badJob, 10]);
        expect(zeroShardPreview[0].length).to.equal(0);

        const [foundHighLane] = await engine.read.findNextJob([0, 10, 99, 0]);
        expect(foundHighLane).to.equal(false);
    });

    it("reverts recordBet when bank cannot cover max liability", async function () {
        const { alice, usdc, bank } = await deployEngineStack();
        await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("1000", 6)], { account: alice.account });
        await expect(
            bank.write.placeBet([parseUnits("100", 6), encodeSingleBet(1n, 7n, parseUnits("100", 6)), zeroAddress], {
                account: alice.account,
            }),
        ).to.be.rejected;
    });

    it("covers settled-market preview and executeJob no-op for unknown kind", async function () {
        const stack = await deployEngineStack();
        const { admin, alice, usdc, vrf, engine, scheduler, bank } = stack;
        const testClient = await viem.getTestClient();

        await usdc.write.mint([admin.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("1000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("500", 6), admin.account.address], { account: admin.account });
        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        await time.increase(550);
        let [, data] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([data]);
        [, data] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([data]);
        await vrf.write.fulfill([engine.address, 1n, 7n]);

        while (true) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
            if (!needed) break;
            await scheduler.write.performUpkeep([performData]);
        }

        const settledJob = {
            kind: 3,
            marketId: 1,
            roundId: 1n,
            nextCursor: 0,
            payoutShardIndex: 0,
            payoutShardWidth: 10,
        };
        const previewAfterSettle = await engine.read.previewPayoutBundle([settledJob, 10]);
        expect(previewAfterSettle[0].length).to.equal(0);

        await testClient.impersonateAccount({ address: scheduler.address });
        await testClient.setBalance({ address: scheduler.address, value: parseUnits("10", 18) });
        const { result: unknownKindOk } = await engine.simulate.executeJob(
            [
                { kind: 0, marketId: 1, roundId: 1n, nextCursor: 0, payoutShardIndex: 0, payoutShardWidth: 10 },
                [],
                [],
                [],
            ],
            { account: scheduler.address },
        );
        expect(unknownKindOk).to.equal(false);
        await testClient.stopImpersonatingAccount({ address: scheduler.address });
    });

    it("covers UpkeepScheduler invalid lane and performData", async function () {
        const { scheduler } = await deployEngineStack();

        const [needed, data] = await scheduler.read.checkUpkeep([laneCheckData(99n)]);
        expect(needed).to.equal(false);
        expect(data).to.equal("0x");

        await expect(scheduler.write.performUpkeep(["0x01"])).to.be.rejected;
        await expect(scheduler.write.performUpkeep(["0x02"])).to.be.rejected;
    });

    it("covers UpkeepManager forwarder approval view", async function () {
        const [admin] = await viem.getWalletClients();
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

        const stranger = "0x0000000000000000000000000000000000000001";
        expect(await manager.read.isApprovedAutomationForwarder([stranger])).to.equal(false);

        await link.write.approve([manager.address, parseUnits("10", 18)]);
        await manager.write.registerLaneUpkeep([3n, 500_000, parseUnits("1", 18), admin.account.address]);
        const forwarder = await registrar.read.getForwarder([2n]);
        expect(await manager.read.isApprovedAutomationForwarder([forwarder])).to.equal(true);
    });

    it("covers BankVault4626 views, side-bet controller, minBet, and partial redeem bps", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const sideBet = await viem.deployContract("SideBet");

        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(usdc.address, mockEngine.address, admin.account.address, 1_000_000n, sideBet.address),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        expect(await vault.read.marketId()).to.equal(1);
        expect(getAddress(await vault.read.ENGINE())).to.equal(getAddress(mockEngine.address));
        expect(await vault.read.minBet()).to.equal(1_000_000n);
        expect(await vault.read.assetDecimals()).to.equal(6);
        expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(sideBet.address));
        expect(await vault.read.availableForSideBet()).to.equal(0n);

        await vault.write.setMinBet([2_000_000n], { account: admin.account });
        expect(await vault.read.minBet()).to.equal(2_000_000n);

        const newSideBet = await viem.deployContract("SideBet");
        await vault.write.setSideBetController([newSideBet.address], { account: admin.account });
        expect(getAddress(await vault.read.sideBetController())).to.equal(getAddress(newSideBet.address));
        await expect(vault.write.setSideBetController(["0x0000000000000000000000000000000000000000"], { account: admin.account })).to
            .be.rejected;

        await usdc.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([vault.address, parseUnits("1000", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        const tinyShares = 1n;
        await expect(
            vault.write.redeem([tinyShares, alice.account.address, alice.account.address], { account: alice.account }),
        ).to.be.rejected;

        await vault.write.redeemBps([100, alice.account.address, alice.account.address], { account: alice.account });
        await mockEngine.write.processWithdrawals([vault.address, 10n]);
    });

    it("covers BRBJackpotFunder brbToken, empty fund, and failure hooks", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const sideBetCaller = await viem.deployContract("SideBet");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            sideBetCaller.address,
            admin.account.address,
        ]);

        expect(getAddress(await funder.read.brbToken())).to.equal(getAddress(brb.address));
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });

        const slice = parseUnits("10", 18);
        await brb.write.transfer([funder.address, slice], { account: admin.account });
        await brb.write.setFailTransfer([true]);
        const treasuryBeforeFail = await brb.read.balanceOf([treasury.address]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeFail);
        expect(await brb.read.balanceOf([funder.address])).to.be.lt(slice);

        await brb.write.setFailTransfer([false]);
        const treasuryBeforeRevert = await brb.read.balanceOf([treasury.address]);
        await brb.write.transfer([funder.address, slice], { account: admin.account });
        await brb.write.setRevertTransfer([true]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });
        expect(await brb.read.balanceOf([treasury.address])).to.equal(treasuryBeforeRevert);
        await brb.write.setRevertTransfer([false]);

        await brb.write.setFailBurn([true]);
        await funder.write.fundFromMarket([1n, brb.address], { account: admin.account });

        await brb.write.transfer([funder.address, parseUnits("1", 18)], { account: admin.account });
        const testClient = await viem.getTestClient();
        await testClient.impersonateAccount({ address: sideBetCaller.address });
        await testClient.setBalance({ address: sideBetCaller.address, value: parseUnits("1", 18) });
        await funder.write.fundFromMarket([1n, brb.address], { account: sideBetCaller.address });
        await testClient.stopImpersonatingAccount({ address: sideBetCaller.address });
    });

    it("covers registry previewNextMarketId with existing markets", async function () {
        const { registry } = await deployEngineStack();
        expect(await registry.read.previewNextMarketId()).to.equal(2n);
    });

    it("covers globalRoundState view and jackpot payout preview batching", async function () {
        const stack = await deployEngineStack();
        const { admin, alice, bob, usdc, vrf, engine, scheduler, bank, brb, treasury } = stack;

        await brb.write.transfer([treasury.address, parseUnits("500", 18)], { account: admin.account });
        await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

        const bet = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, bet);
        for (const player of [alice, bob]) {
            await usdc.write.mint([player.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: player.account });
            await bank.write.placeBet([bet, straight7, zeroAddress], { account: player.account });
        }

        await time.increase(550);
        const [, preLock] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLock]);
        const [, vrfJob] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfJob]);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 7n, 7n]);

        const gr = await engine.read.globalRoundState([1n]);
        const vrfFulfilled = Array.isArray(gr) ? gr[0] : (gr as { vrfFulfilled: boolean }).vrfFulfilled;
        expect(vrfFulfilled).to.equal(true);

        const [, payoutData] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
        const decoded = decodeRoulettePerformData(payoutData);
        expect(decoded.jobKind).to.equal(3);
        await scheduler.write.performUpkeep([payoutData]);

        const payoutJob = {
            kind: decoded.jobKind,
            marketId: decoded.marketId,
            roundId: decoded.roundId,
            nextCursor: decoded.nextCursor,
            payoutShardIndex: decoded.shardIndex,
            payoutShardWidth: decoded.shardWidth,
        };
        expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(false);
    });

    it("covers RouletteEngine jackpot lane work before BRB distribution", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler, jackpotTreasury: treasury, funder, registry } = await deployRouletteEngine(
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
            { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 1 },
            {
                protocolPrefix: {
                    brb: brb.address,
                    mockRouter: router.address,
                    admin: admin.account.address,
                },
            },
        );
        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
            { account: admin.account },
        );
        const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);

        await brb.write.transfer([treasury.address, parseUnits("1000", 18)], { account: admin.account });
        await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });

        const bet = parseUnits("10", 6);
        const straight7 = encodeSingleBet(1n, 7n, bet);
        for (const player of [alice, bob]) {
            await usdc.write.mint([player.account.address, parseUnits("100", 6)]);
            await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: player.account });
            await bank.write.placeBet([bet, straight7, zeroAddress], { account: player.account });
        }

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
            payoutShardWidth: 10,
        };
        expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(true);

        const [, jackpotTriggered] = await engine.read.roundJackpotTriggered([1n]);
        expect(jackpotTriggered).to.equal(true);

        while (await engine.read.payoutLaneHasWork([payoutJob])) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
            if (!needed) break;
            await scheduler.write.performUpkeep([performData]);
        }
        expect(await engine.read.payoutLaneHasWork([payoutJob])).to.equal(false);
    });

    it("covers UpkeepScheduler SideBet path and admin setters", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const { usdc, roundEngine, sideBet, bank } = await deployMockSideBetMarketStack(admin);

        const scheduler = await viem.deployContract("UpkeepScheduler", [
            roundEngine.address,
            sideBet.address,
            admin.account.address,
            32,
            32,
        ]);
        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, scheduler.address], { account: admin.account });
        await wireTestSchedulerForwarder(scheduler, admin.account);

        await usdc.write.mint([admin.account.address, parseUnits("10000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("10000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("10000", 6), admin.account.address], { account: admin.account });

        const configId = await registerSideBetNumberHit(sideBet, admin.account);
        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
        await sideBet.write.placeBet([configId, parseUnits("10", 6)], { account: alice.account });
        expect(await bank.read.lockedBetLiquidity()).to.be.gt(0n);

        await roundEngine.write.fulfillRounds([[8]]);
        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);
        expect(performData).to.not.equal("0x");
        expect(Number(decodeAbiParameters([{ type: "uint8" }], performData)[0])).to.equal(1);
        await scheduler.write.performUpkeep([performData]);
        expect((await sideBet.read.getBet([0n])).status).to.equal(2);

        await expect(scheduler.write.setScanLimit([0], { account: admin.account })).to.be.rejected;
        await expect(scheduler.write.setMaxPayoutsPerCall([0], { account: admin.account })).to.be.rejected;

        const invalidKind = encodeAbiParameters([{ type: "uint8" }], [2]) as Hex;
        await scheduler.write.performUpkeep([invalidKind]);
    });

    it("covers ProtocolTimelock receive and LPVestingLock release overload", async function () {
        const [admin, beneficiary, proposer, executor] = await viem.getWalletClients();

        const lp = await viem.deployContract("MockUSDC");
        const lock = await viem.deployContract("LPVestingLock", [
            lp.address,
            beneficiary.account.address,
            admin.account.address,
        ]);
        await lp.write.mint([lock.address, parseUnits("50", 6)]);
        await time.increase(3 * 365 * 24 * 60 * 60 + 1);
        await lock.write.release([beneficiary.account.address], { account: beneficiary.account });
        expect(await lp.read.balanceOf([beneficiary.account.address])).to.equal(parseUnits("50", 6));

        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);
        const walletClient = await viem.getWalletClient(admin.account.address);
        await walletClient.sendTransaction({ to: timelock.address, value: parseUnits("0.01", 18) });
        const publicClient = await viem.getPublicClient();
        expect(await publicClient.getBalance({ address: timelock.address })).to.equal(parseUnits("0.01", 18));
    });

    it("covers SideBet preview lane alignment and full batch buffer reuse", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const { usdc, roundEngine, sideBet, bank } = await deployMockSideBetMarketStack(admin);

        await usdc.write.mint([admin.account.address, parseUnits("10000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("10000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("10000", 6), admin.account.address], { account: admin.account });

        const cfg = await registerSideBetNumberHit(sideBet, admin.account, 1);
        for (const player of [alice, bob]) {
            await usdc.write.mint([player.account.address, parseUnits("50", 6)]);
            await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: player.account });
            await sideBet.write.placeBet([cfg, parseUnits("10", 6)], { account: player.account });
        }
        await roundEngine.write.fulfillRounds([[8]]);

        const aligned = await sideBet.read.previewSettleBundle([0n, 2, 2, 3]);
        expect(aligned[0].length).to.equal(0);

        const fullBatch = await sideBet.read.previewSettleBundle([0n, 2, 0, 1]);
        expect(fullBatch[0].length).to.equal(2);
    });

    it("covers SideBet settleBatch rejecting loser rows with nonzero payout", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const { usdc, roundEngine, sideBet, bank } = await deployMockSideBetMarketStack(admin);

        await usdc.write.mint([admin.account.address, parseUnits("10000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("10000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("10000", 6), admin.account.address], { account: admin.account });

        const cfg = await registerSideBetNumberHit(sideBet, admin.account, 1);
        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
        await sideBet.write.placeBet([cfg, parseUnits("10", 6)], { account: alice.account });
        await roundEngine.write.fulfillRounds([[8]]);

        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, admin.account.address], { account: admin.account });
        await sideBet.write.settleBatch(
            [[{ betId: 0n, won: false, payoutAmount: parseUnits("1", 6) }], []],
            { account: admin.account },
        );
        expect((await sideBet.read.getBet([0n])).status).to.equal(0);

        await sideBet.write.settleBatch([[{ betId: 0n, won: false, payoutAmount: 0n }], []], { account: admin.account });
        expect((await sideBet.read.getBet([0n])).status).to.equal(2);
    });

    it("covers BankVault4626 lockSideBetStake liquidity guard", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const { usdc, sideBet, bank } = await deployMockSideBetMarketStack(admin);

        await usdc.write.mint([admin.account.address, parseUnits("30", 6)]);
        await usdc.write.approve([bank.address, parseUnits("30", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("20", 6), admin.account.address], { account: admin.account });

        await sideBet.write.addConfig(
            [
                {
                    marketId: 1,
                    betType: 1,
                    color: 0,
                    targetNumber: 7,
                    targetCount: 1,
                    redRatioBps: 0,
                    windowSpins: 1,
                    multiplierBps: 1_000_000,
                    minStake: 0n,
                    maxStake: 0n,
                },
            ],
            { account: admin.account },
        );
        const configId = (await sideBet.read.configCount()) - 1n;
        await sideBet.write.setConfigStakeLimits([configId, 1_000_000n, 1_000_000_000n], { account: admin.account });

        await usdc.write.mint([alice.account.address, parseUnits("20", 6)]);
        await usdc.write.approve([bank.address, parseUnits("20", 6)], { account: alice.account });
        await expect(sideBet.write.placeBet([configId, parseUnits("10", 6)], { account: alice.account })).to.be.rejected;
    });

    it("covers UpkeepScheduler no-op for unknown work kind", async function () {
        const { scheduler } = await deployEngineStack();
        const invalidKind = encodeAbiParameters([{ type: "uint8" }], [2]) as Hex;
        await scheduler.write.performUpkeep([invalidKind]);
    });
});
