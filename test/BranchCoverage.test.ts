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

import { deploySideBetProxy, deploySideBetRegistryStack } from "./helpers/deploySideBetRegistryStack";
import { encodeSingleBet } from "./helpers/multiBetEncode";
import { laneCheckData } from "./helpers/parallelUpkeep";

const USDC = (v: string) => parseUnits(v, 6);

/** SideBet config helper (matches SideBet.test.ts). */
function sideBetConfig(overrides: Record<string, unknown> = {}) {
    return {
        marketId: 1,
        betType: 1,
        color: 0,
        targetNumber: 0,
        targetCount: 1,
        redRatioBps: 0,
        windowSpins: 3,
        multiplierBps: 100_000,
        minStake: 0n,
        maxStake: 0n,
        ...overrides,
    };
}

describe("Branch coverage — registry & upkeep ops", function () {
    it("MarketRegistry: constructor reverts, setter reverts, and ZeroImplementation beacon", async function () {
        const [admin, stranger] = await viem.getWalletClients();
        const roundEngine = await viem.deployContract("MockRoundEngine");

        await expect(
            viem.deployContract("MarketRegistry", [zeroAddress, roundEngine.address, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("MarketRegistry", [admin.account.address, zeroAddress, admin.account.address]),
        ).to.be.rejected;
        await expect(
            viem.deployContract("MarketRegistry", [admin.account.address, roundEngine.address, zeroAddress]),
        ).to.be.rejected;

        const registry = await viem.deployContract("MarketRegistry", [
            admin.account.address,
            roundEngine.address,
            admin.account.address,
        ]);

        await expect(registry.write.setVaultBeacon([zeroAddress], { account: admin.account })).to.be.rejected;
        await expect(
            registry.write.setVaultBeacon([stranger.account.address], { account: admin.account }),
        ).to.be.rejected;

        const token = await viem.deployContract("MockUSDC");
        await expect(
            registry.write.createMarket(
                [{ asset: zeroAddress, bankAdmin: admin.account.address, minBet: 1_000_000n }],
                { account: admin.account },
            ),
        ).to.be.rejected;
        await expect(
            registry.write.createMarket(
                [{ asset: token.address, bankAdmin: zeroAddress, minBet: 1_000_000n }],
                { account: admin.account },
            ),
        ).to.be.rejected;
        await expect(
            registry.write.createMarket(
                [{ asset: token.address, bankAdmin: admin.account.address, minBet: 0n }],
                { account: admin.account },
            ),
        ).to.be.rejected;
        await expect(registry.write.setVaultBeacon([token.address], { account: stranger.account })).to.be.rejected;
    });

    it("UpkeepManager: lane-0 checkData and non-zero initialRegistrant", async function () {
        const [admin, registrant] = await viem.getWalletClients();
        const link = await viem.deployContract("MockLinkToken");
        const registrar = await viem.deployContract("MockKeeperRegistry");

        await viem.deployContract("UpkeepManager", [
            link.address,
            registrar.address,
            registrar.address,
            admin.account.address,
            admin.account.address,
            registrant.account.address,
        ]);

        const manager = await viem.deployContract("UpkeepManager", [
            link.address,
            registrar.address,
            registrar.address,
            admin.account.address,
            admin.account.address,
            zeroAddress,
        ]);

        await link.write.approve([manager.address, parseUnits("10", 18)]);
        await manager.write.registerLaneUpkeep([0n, 400_000, parseUnits("1", 18), admin.account.address]);
        await manager.write.registerLaneUpkeep([4n, 400_000, parseUnits("1", 18), admin.account.address]);
        expect(await manager.read.isApprovedAutomationForwarder([admin.account.address])).to.equal(true);
    });
});

describe("Branch coverage — fee & treasury", function () {
    it("BRBJackpotFunder: empty fund, engine guard, and fee-hook branches", async function () {
        const [admin, stranger] = await viem.getWalletClients();
        const brb = await viem.deployContract("MockBRBWithFeeHooks", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [
            brb.address,
            admin.account.address,
            admin.account.address,
        ]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            admin.account.address,
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
            admin.account.address,
        ]);
        const usdc = await viem.deployContract("MockUSDC");

        await funder.write.fundFromMarket([1n, usdc.address], { account: admin.account });

        await expect(funder.write.fundFromMarket([1n, usdc.address], { account: stranger })).to.be.rejected;

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
    });

    it("BRBReferal: constructor zero engine", async function () {
        await expect(viem.deployContract("BRBReferal", [zeroAddress])).to.be.rejected;
    });
});

describe("Branch coverage — ProtocolTimelock", function () {
    it("reverts execute when msg.value mismatches queued value", async function () {
        const [admin, proposer, executor] = await viem.getWalletClients();
        const timelock = await viem.deployContract("ProtocolTimelock", [
            admin.account.address,
            proposer.account.address,
            executor.account.address,
        ]);
        const callee = await viem.deployContract("MockTimelockCallee");
        const salt = 3n;
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
});

describe("Branch coverage — SideBet config validation", function () {
    async function sideBetFixture() {
        const [admin] = await viem.getWalletClients();
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
            [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );
        return { sideBet, admin };
    }

    const invalidCases: { name: string; cfg: ReturnType<typeof sideBetConfig> }[] = [
        { name: "NUMBER_HIT targetNumber", cfg: sideBetConfig({ betType: 1, targetNumber: 37 }) },
        { name: "NUMBER_HIT targetCount", cfg: sideBetConfig({ betType: 1, targetCount: 0 }) },
        { name: "COLOR_COUNT targetCount", cfg: sideBetConfig({ betType: 0, targetCount: 0 }) },
        { name: "RED_RATIO bps", cfg: sideBetConfig({ betType: 3, redRatioBps: 0 }) },
        { name: "LIGHTNING_DOUBLE number", cfg: sideBetConfig({ betType: 4, targetNumber: 38, targetCount: 2, windowSpins: 4 }) },
        { name: "LIGHTNING_DOUBLE count", cfg: sideBetConfig({ betType: 4, targetNumber: 37, targetCount: 1, windowSpins: 4 }) },
        { name: "PERFECT_ALTERNATION window", cfg: sideBetConfig({ betType: 5, windowSpins: 1 }) },
        { name: "DOZEN_HIT targetNumber", cfg: sideBetConfig({ betType: 6, targetNumber: 0 }) },
        { name: "unknown market", cfg: sideBetConfig({ marketId: 99 }) },
    ];

    for (const { name, cfg } of invalidCases) {
        it(`reverts addConfig: ${name}`, async function () {
            const { sideBet, admin } = await sideBetFixture();
            await expect(sideBet.write.addConfig([cfg], { account: admin.account })).to.be.rejected;
        });
    }

    it("previewSettleBundle early exits (maxBets, lane)", async function () {
        const { sideBet } = await sideBetFixture();
        expect((await sideBet.read.previewSettleBundle([0n, 0, 0, 1]))[0].length).to.equal(0);
        expect((await sideBet.read.previewSettleBundle([0n, 1, 1, 1]))[0].length).to.equal(0);
    });
});

describe("Branch coverage — BankVault4626", function () {
    it("withdrawal queue: zero payout when gross <= fee", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const init = encodeFunctionData({
            abi: impl.abi,
            functionName: "initialize",
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
            args: [
                {
                    assetToken: usdc.address,
                    name: "BRB USDC",
                    symbol: "bUSDC",
                    marketId: 1,
                    engine: mockEngine.address,
                    admin: admin.account.address,
                    minBet: 1_000_000n,
                    sideBetController: zeroAddress,
                },
            ],
        });
        const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, init]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("5", 6)]);
        await usdc.write.approve([vault.address, parseUnits("5", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("2", 6), alice.account.address], { account: alice.account });
        await vault.write.redeemBps([1, alice.account.address, alice.account.address], { account: alice.account });
        const before = await usdc.read.balanceOf([alice.account.address]);
        await mockEngine.write.processWithdrawals([vault.address, 1n]);
        expect(await usdc.read.balanceOf([alice.account.address])).to.equal(before);
    });

    it("totalAssets when locked exceeds gross", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const init = encodeFunctionData({
            abi: impl.abi,
            functionName: "initialize",
            args: [
                {
                    assetToken: usdc.address,
                    name: "BRB USDC",
                    symbol: "bUSDC",
                    marketId: 1,
                    engine: mockEngine.address,
                    admin: admin.account.address,
                    minBet: 1_000_000n,
                    sideBetController: zeroAddress,
                },
            ],
        });
        const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, init]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await usdc.write.mint([alice.account.address, parseUnits("20", 6)]);
        await usdc.write.approve([vault.address, parseUnits("20", 6)], { account: alice.account });
        await vault.write.placeBet([parseUnits("20", 6), "0x", zeroAddress], { account: alice.account });
        expect(await vault.read.totalAssets()).to.equal(0n);
    });
});

describe("Branch coverage — UpkeepScheduler", function () {
    it("checkUpkeep with empty checkData and invalid lane", async function () {
        const stack = await deployMinimalSchedulerStack();
        const { scheduler } = stack;

        const [neededEmpty] = await scheduler.read.checkUpkeep(["0x"]);
        expect(neededEmpty).to.be.a("boolean");

        const [neededBadLane, dataBadLane] = await scheduler.read.checkUpkeep([laneCheckData(99n)]);
        expect(neededBadLane).to.equal(false);
        expect(dataBadLane).to.equal("0x");
    });

    it("blocks performUpkeep when forwarder authority rejects caller", async function () {
        const stack = await deployMinimalSchedulerStack();
        const { scheduler, admin, manager } = stack;

        await scheduler.write.setForwarderAuthority([manager.address], { account: admin.account });
        const [alice] = await viem.getWalletClients();
        const [, data] = await scheduler.read.checkUpkeep(["0x"]);
        if (data !== "0x") {
            await expect(scheduler.write.performUpkeep([data], { account: alice.account })).to.be.rejected;
        }
    });

    it("no-ops performUpkeep on unknown work kind (trusted checkUpkeep calldata)", async function () {
        const { scheduler } = await deployMinimalSchedulerStack();
        const invalidKind = encodeAbiParameters([{ type: "uint8" }], [2]) as `0x${string}`;
        await scheduler.write.performUpkeep([invalidKind]);
    });
});

describe("Branch coverage — RouletteEngine views & admin bounds", function () {
    it("exposes marketRoundStateByRound and enforces queue/lane setter bounds", async function () {
        const [admin, payoutAdmin] = await viem.getWalletClients();
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, registry, jackpotTreasury: treasury, funder } = await deployRouletteEngine(
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
            [{ asset: (await viem.deployContract("MockUSDC")).address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
            { account: admin.account },
        );

        const mr = await engine.read.marketRoundStateByRound([1n, 1]);
        expect(mr.settled).to.equal(false);

        const payoutRole = await engine.read.ENGINE_PAYOUT_ROLE();
        await engine.write.grantRole([payoutRole, payoutAdmin.account.address], { account: admin.account });
        await expect(engine.write.setPayoutLaneCount([0], { account: payoutAdmin.account })).to.be.rejected;

        const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
        await engine.write.grantRole([withdrawalRole, payoutAdmin.account.address], { account: admin.account });
        await expect(engine.write.setMaxWithdrawalQueueLength([0], { account: payoutAdmin.account })).to.be.rejected;
        await expect(engine.write.setMaxWithdrawalQueueLength([1001], { account: payoutAdmin.account })).to.be.rejected;
    });
});

describe("Branch coverage — BankVault4626 revert paths", function () {
    async function vaultWithEngine(engineAddress: `0x${string}`, maxQueue = 100n) {
        const [admin, alice] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const impl = await viem.deployContract("BankVault4626");
        const init = encodeFunctionData({
            abi: impl.abi,
            functionName: "initialize",
            args: [
                {
                    assetToken: usdc.address,
                    name: "BRB USDC",
                    symbol: "bUSDC",
                    marketId: 1,
                    engine: engineAddress,
                    admin: admin.account.address,
                    minBet: 1_000_000n,
                    sideBetController: zeroAddress,
                },
            ],
        });
        const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, init]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);
        return { admin, alice, usdc, vault, maxQueue };
    }

    it("reverts deposit, withdraw, pending withdrawal, and receiver checks", async function () {
        const restricted = await viem.deployContract("MockEngineRestricted");
        const { alice, usdc, vault } = await vaultWithEngine(restricted.address);

        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([vault.address, parseUnits("50", 6)], { account: alice.account });

        await expect(vault.write.deposit([parseUnits("5", 6), alice.account.address], { account: alice.account })).to.be.rejected;
        await expect(
            vault.write.withdraw([parseUnits("1", 6), alice.account.address, alice.account.address], { account: alice.account }),
        ).to.be.rejected;

        const mockEngine = await viem.deployContract("MockEngine");
        const { alice: a2, usdc: t2, vault: v2 } = await vaultWithEngine(mockEngine.address);
        await t2.write.mint([a2.account.address, parseUnits("50", 6)]);
        await t2.write.approve([v2.address, parseUnits("50", 6)], { account: a2.account });
        await v2.write.deposit([parseUnits("20", 6), a2.account.address], { account: a2.account });
        await v2.write.redeemBps([5000, a2.account.address, a2.account.address], { account: a2.account });
        await expect(
            v2.write.redeemBps([1000, a2.account.address, a2.account.address], { account: a2.account }),
        ).to.be.rejected;
        await expect(
            v2.write.redeemBps([100, zeroAddress, a2.account.address], { account: a2.account }),
        ).to.be.rejected;
        await expect(v2.write.releaseBets([1n], { account: alice.account })).to.be.rejected;
    });
});

describe("Branch coverage — SideBet config admin", function () {
    it("reverts removeConfig/updateConfig on unknown or inactive ids", async function () {
        const [admin] = await viem.getWalletClients();
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
            [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
            { account: admin.account },
        );

        await expect(sideBet.write.removeConfig([0n], { account: admin.account })).to.be.rejected;
        await sideBet.write.addConfig([sideBetConfig()], { account: admin.account });
        const configId = (await sideBet.read.configCount()) - 1n;
        await sideBet.write.setConfigStakeLimits([configId, USDC("1"), USDC("100")], { account: admin.account });
        await sideBet.write.removeConfig([configId], { account: admin.account });
        await expect(sideBet.write.removeConfig([configId], { account: admin.account })).to.be.rejected;
        await expect(
            sideBet.write.updateConfig([configId, sideBetConfig({ multiplierBps: 200_000 })], { account: admin.account }),
        ).to.be.rejected;
    });
});

describe("Branch coverage — §4 matrix (doc checklist)", function () {
    it("UpkeepManager: each constructor zero-address param reverts", async function () {
        const [admin] = await viem.getWalletClients();
        const link = await viem.deployContract("MockLinkToken");
        const registrar = await viem.deployContract("MockKeeperRegistry");
        const zero = zeroAddress;
        const valid = [link.address, registrar.address, registrar.address, admin.account.address, admin.account.address, zeroAddress];

        const cases: { label: string; args: [Address, Address, Address, Address, Address, Address] }[] = [
            { label: "linkToken", args: [zero, valid[1], valid[2], valid[3], valid[4], valid[5]] },
            { label: "keeperRegistrar", args: [valid[0], zero, valid[2], valid[3], valid[4], valid[5]] },
            { label: "keeperRegistry", args: [valid[0], valid[1], zero, valid[3], valid[4], valid[5]] },
            { label: "upkeepTarget", args: [valid[0], valid[1], valid[2], zero, valid[4], valid[5]] },
            { label: "admin", args: [valid[0], valid[1], valid[2], valid[3], zero, valid[5]] },
        ];

        for (const { args } of cases) {
            await expect(viem.deployContract("UpkeepManager", args)).to.be.rejected;
        }
    });

    it("UpkeepScheduler: SideBet checkUpkeep when roulette findNextJob is empty", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const { usdc, roundEngine, sideBet, bank } = await deploySideBetFixtureFromMatrix();

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

        await usdc.write.mint([admin.account.address, parseUnits("10000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("10000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("10000", 6), admin.account.address], { account: admin.account });

        await sideBet.write.addConfig([sideBetConfig({ betType: 1, windowSpins: 1 })], { account: admin.account });
        const configId = (await sideBet.read.configCount()) - 1n;
        await sideBet.write.setConfigStakeLimits([configId, 1_000_000n, 1_000_000_000n], { account: admin.account });
        await usdc.write.mint([alice.account.address, parseUnits("50", 6)]);
        await usdc.write.approve([bank.address, parseUnits("50", 6)], { account: alice.account });
        await sideBet.write.placeBet([configId, parseUnits("10", 6)], { account: alice.account });
        await roundEngine.write.fulfillRounds([[8]]);

        const [needed, performData] = await scheduler.read.checkUpkeep(["0x"]);
        expect(needed).to.equal(true);
        expect(Number(decodeAbiParameters([{ type: "uint8" }], performData)[0])).to.equal(1);
    });

    it("RouletteEngine: isBankLiquidityRestricted in Locked and Settling", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const { engine, scheduler, bank, usdc, vrf } = await deployMinimalSchedulerStack();

        await usdc.write.mint([admin.account.address, parseUnits("5000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("5000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("2000", 6), admin.account.address], { account: admin.account });
        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        await bank.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6)), zeroAddress], {
            account: alice.account,
        });

        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(false);

        await time.increase(550);
        let [, data] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([data]);
        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);

        [, data] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([data]);
        await vrf.write.fulfill([engine.address, 1n, 7n]);
        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(true);

        while (true) {
            const [needed, performData] = await scheduler.read.checkUpkeep([laneCheckData(0n)]);
            if (!needed) break;
            await scheduler.write.performUpkeep([performData]);
        }
        expect(await engine.read.isBankLiquidityRestricted([1])).to.equal(false);
    });

    it("BankVault4626: QueueFull when queue length reaches engine cap", async function () {
        const [admin, alice, bob] = await viem.getWalletClients();
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, registry, jackpotTreasury: treasury, funder } = await deployRouletteEngine(
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

        const withdrawalRole = await engine.read.ENGINE_WITHDRAWAL_ROLE();
        await engine.write.grantRole([withdrawalRole, admin.account.address], { account: admin.account });
        await engine.write.setMaxWithdrawalQueueLength([1], { account: admin.account });

        const token = await viem.deployContract("MockERC20Permit");
        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [{ asset: token.address, bankAdmin: admin.account.address, minBet: parseUnits("1", 18) }],
            { account: admin.account },
        );
        const vault = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);

        await token.write.mint([alice.account.address, parseUnits("100", 18)]);
        await token.write.mint([bob.account.address, parseUnits("100", 18)]);
        await token.write.approve([vault.address, parseUnits("100", 18)], { account: alice.account });
        await token.write.approve([vault.address, parseUnits("100", 18)], { account: bob.account });
        await vault.write.deposit([parseUnits("50", 18), alice.account.address], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 18), bob.account.address], { account: bob.account });

        await vault.write.redeemBps([1000, alice.account.address, alice.account.address], { account: alice.account });
        await expect(
            vault.write.redeemBps([1000, bob.account.address, bob.account.address], { account: bob.account }),
        ).to.be.rejected;
    });

    it("LPVestingLock: all release revert branches", async function () {
        const [admin, beneficiary] = await viem.getWalletClients();
        const lp = await viem.deployContract("MockUSDC");

        await expect(viem.deployContract("LPVestingLock", [zeroAddress, beneficiary.account.address, admin.account.address])).to
            .be.rejected;
        await expect(viem.deployContract("LPVestingLock", [lp.address, zeroAddress, admin.account.address])).to.be.rejected;
        await expect(viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, zeroAddress])).to.be.rejected;

        const lock = await viem.deployContract("LPVestingLock", [lp.address, beneficiary.account.address, admin.account.address]);
        await lp.write.mint([lock.address, parseUnits("10", 6)]);

        await expect(lock.write.release([beneficiary.account.address], { account: beneficiary.account })).to.be.rejected;
        await time.increase(3 * 365 * 24 * 60 * 60 + 1);
        await expect(
            lock.write.release([zeroAddress, parseUnits("1", 6)], { account: beneficiary.account }),
        ).to.be.rejected;
        await expect(lock.write.release([beneficiary.account.address, 0n], { account: beneficiary.account })).to.be.rejected;
        await expect(
            lock.write.release([beneficiary.account.address, parseUnits("100", 6)], { account: beneficiary.account }),
        ).to.be.rejected;
    });

    it("SideBet: setMultiplierBand bounds", async function () {
        const { sideBet, admin } = await sideBetFixtureFromMatrix();
        await expect(sideBet.write.setMultiplierBand([10_000, 5_000_000], { account: admin.account })).to.be.rejected;
        await expect(sideBet.write.setMultiplierBand([50_000, 40_000], { account: admin.account })).to.be.rejected;
    });

    it("MarketRegistry: happy path createMarket after valid beacon", async function () {
        const [admin] = await viem.getWalletClients();
        const usdc = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { registry } = await deployRouletteEngine(
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
        expect(getAddress(cfg.asset)).to.equal(getAddress(usdc.address));
        expect(getAddress(cfg.bank)).to.not.equal(getAddress(zeroAddress));
    });

    it("BankVault4626: OnlySideBet and queue head reset after drain", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const mockEngine = await viem.deployContract("MockEngine");
        const token = await viem.deployContract("MockUSDC");
        const impl = await viem.deployContract("BankVault4626");
        const init = encodeFunctionData({
            abi: impl.abi,
            functionName: "initialize",
            args: [
                {
                    assetToken: token.address,
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
        const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, init]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await expect(
            vault.write.lockSideBetStake([alice.account.address, 1n, 1n], { account: alice.account }),
        ).to.be.rejected;

        await token.write.mint([alice.account.address, parseUnits("100", 6)]);
        await token.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("50", 6), alice.account.address], { account: alice.account });
        await vault.write.redeemBps([5000, alice.account.address, alice.account.address], { account: alice.account });
        await mockEngine.write.processWithdrawals([vault.address, 10n]);
        await vault.write.redeemBps([1000, alice.account.address, alice.account.address], { account: alice.account });
    });
});

async function deploySideBetFixtureFromMatrix() {
    const [admin] = await viem.getWalletClients();
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
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: USDC("1") }],
        { account: admin.account },
    );
    const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);
    return { sideBet, admin, usdc, roundEngine, bank };
}

async function sideBetFixtureFromMatrix() {
    const { sideBet, admin } = await deploySideBetFixtureFromMatrix();
    return { sideBet, admin };
}

async function deployMinimalSchedulerStack() {
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

    const link = await viem.deployContract("MockLinkToken");
    const registrar = await viem.deployContract("MockKeeperRegistry");
    const manager = await viem.deployContract("UpkeepManager", [
        link.address,
        registrar.address,
        registrar.address,
        scheduler.address,
        admin.account.address,
        admin.account.address,
    ]);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
    await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
    await registry.write.createMarket(
        [{ asset: usdc.address, bankAdmin: admin.account.address, minBet: 1_000_000n }],
        { account: admin.account },
    );
    const bank = await viem.getContractAt("BankVault4626", (await registry.read.getMarket([1])).bank);

    return { admin, alice, bob, scheduler, manager, sideBet, engine, registry, usdc, vrf, bank };
}
