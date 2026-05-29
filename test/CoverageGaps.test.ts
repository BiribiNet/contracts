import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { deployRouletteEngine } from "../scripts/utils/deployRouletteEngine";
import { encodeAbiParameters, encodeFunctionData, parseUnits, type Address, type Hex } from "viem";

function encodeSingleBet(betType: bigint, number: bigint, amount: bigint) {
    return encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        [[betType], [number], [amount]],
    );
}

describe("Coverage gaps", function () {
    it("covers MarketRegistry getMarket validity and previewNextMarketId", async function () {
        const [admin] = await viem.getWalletClients();
        const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);

        await expect(registry.read.getMarket([0])).to.be.rejected;
        await expect(registry.read.getMarket([1])).to.be.rejected;

        const token = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                registry.address,
                treasury.address,
                funder.address,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                500,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
        );
        await treasury.write.setEngine([engine.address]);
        await funder.write.setEngine([engine.address]);

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.setEngine([engine.address], { account: admin.account });
        await registry.write.createMarket(
            [
                {
                    asset: token.address,
                    bankAdmin: admin.account.address,

                minBet: 1_000_000n,
                },
            ],
            { account: admin.account },
        );

        const cfg = await registry.read.getMarket([1]);
        expect(cfg.asset.toLowerCase()).to.equal(token.address.toLowerCase());
        await expect(registry.read.getMarket([2])).to.be.rejected;
        expect(await registry.read.previewNextMarketId()).to.equal(2n);
    });

    it("covers BankVault4626 maxWithdraw/maxRedeem paths", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const token = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(token.address, "Bank", "b", 1, mockEngine.address, admin.account.address, 1_000_000n),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await token.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await token.write.approve([vault.address, parseUnits("1000", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        // With no locked bets, freeLiquidity == totalAssets.
        const mw = await vault.read.maxWithdraw([alice.account.address]);
        expect(mw).to.equal(parseUnits("100", 6));
        const mr = await vault.read.maxRedeem([alice.account.address]);
        expect(mr).to.be.gt(0n);

        // Place a bet to exercise the view paths again under nonzero lockedBetLiquidity.
        await vault.write.placeBet([parseUnits("10", 6), encodeSingleBet(1n, 7n, parseUnits("10", 6))], { account: alice.account });
        const mw2 = await vault.read.maxWithdraw([alice.account.address]);
        expect(mw2).to.be.gt(0n);
        const mr2 = await vault.read.maxRedeem([alice.account.address]);
        expect(mr2).to.be.gt(0n);
    });

    it("covers BankVault4626 withdrawal queue happy path", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const token = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(token.address, "Bank", "b", 1, mockEngine.address, admin.account.address, 1_000_000n),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await token.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await token.write.approve([vault.address, parseUnits("1000", 6)], { account: alice.account });
        await vault.write.deposit([parseUnits("100", 6), alice.account.address], { account: alice.account });

        await vault.write.withdraw([parseUnits("1", 6), alice.account.address, alice.account.address], { account: alice.account });
        await mockEngine.write.processWithdrawals([vault.address, 10n]);

        const shares = await vault.read.balanceOf([alice.account.address]);
        await vault.write.redeem([shares / 10n, alice.account.address, alice.account.address], { account: alice.account });
        await mockEngine.write.processWithdrawals([vault.address, 10n]);
    });

    it("covers BankVault4626 mint happy path", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const token = await viem.deployContract("MockUSDC");
        const mockEngine = await viem.deployContract("MockEngine");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(token.address, "Bank", "b", 1, mockEngine.address, admin.account.address, 1_000_000n),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await token.write.mint([alice.account.address, parseUnits("1000", 6)]);
        await token.write.approve([vault.address, parseUnits("1000", 6)], { account: alice.account });

        const shares = await vault.write.mint([parseUnits("10", 6), alice.account.address], { account: alice.account });
        expect(shares).to.not.equal(undefined);
    });

    it("covers BRBJackpotFunder.setSlippageBps bounds", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);

        await funder.write.setSlippageBps([1], { account: admin.account });
        await expect(funder.write.setSlippageBps([10_000], { account: admin.account })).to.be.rejected;
    });

    it("covers BRBJackpotFunder constructor and setSwapAssetBps bounds", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");

        await expect(
            viem.deployContract("BRBJackpotFunder", [
                "0x0000000000000000000000000000000000000000",
                brb.address,
                router.address,
                "0x0000000000000000000000000000000000000000",
                admin.account.address,
            ]),
        ).to.be.rejected;

        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);

        await funder.write.setSwapAssetBps([0], { account: admin.account });
        await expect(funder.write.setSwapAssetBps([1001], { account: admin.account })).to.be.rejected;
    });

    it("covers BRBJackpotFunder.setTreasuryBrbSplit bounds", async function () {
        const [admin] = await viem.getWalletClients();
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);

        await funder.write.setTreasuryBrbSplit([1, 2], { account: admin.account });
        await expect(funder.write.setTreasuryBrbSplit([2, 1], { account: admin.account })).to.be.rejected;
        await expect(funder.write.setTreasuryBrbSplit([1, 0], { account: admin.account })).to.be.rejected;
    });

    it("covers restricted deposit/mint/withdraw paths", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const token = await viem.deployContract("MockUSDC");
        const restrictedEngine = await viem.deployContract("MockEngineRestricted");
        const impl = await viem.deployContract("BankVault4626");
        const proxy = await viem.deployContract("ERC1967Proxy", [
            impl.address,
            vaultInitData(token.address, "Bank", "b", 1, restrictedEngine.address, admin.account.address, 1_000_000n),
        ]);
        const vault = await viem.getContractAt("BankVault4626", proxy.address);

        await token.write.mint([alice.account.address, parseUnits("100", 6)]);
        await token.write.approve([vault.address, parseUnits("100", 6)], { account: alice.account });

        await expect(vault.write.deposit([parseUnits("1", 6), alice.account.address], { account: alice.account })).to.be.rejected;
        await expect(vault.write.mint([1n, alice.account.address], { account: alice.account })).to.be.rejected;
        await expect(vault.write.withdraw([1n, alice.account.address, alice.account.address], { account: alice.account })).to.be.rejected;
    });

    it("reverts on invalid roulette bet number (covers validateBetNumber revert)", async function () {
        const [admin, alice] = await viem.getWalletClients();

        const usdc = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                registry.address,
                treasury.address,
                funder.address,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                500,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 10, maxPayoutsPerCall: 10 },
        );
        await treasury.write.setEngine([engine.address]);
        await funder.write.setEngine([engine.address]);
        await registry.write.setEngine([engine.address], { account: admin.account });

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [
                {
                    asset: usdc.address,
                    bankAdmin: admin.account.address,

                minBet: 1_000_000n,
                },
            ],
            { account: admin.account },
        );
        const cfg = await registry.read.getMarket([1]);
        const bank = await viem.getContractAt("BankVault4626", cfg.bank);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });

        // Straight bet number > 36 should revert in engine validation.
        await expect(
            bank.write.placeBet([parseUnits("1", 6), encodeSingleBet(1n, 37n, parseUnits("1", 6))], { account: alice.account }),
        ).to.be.rejected;
    });

    it("reverts when non-straight bet specifies a number (covers validateBetNumber number!=0)", async function () {
        const [admin, alice] = await viem.getWalletClients();

        const usdc = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                registry.address,
                treasury.address,
                funder.address,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                500,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 10, maxPayoutsPerCall: 10 },
        );
        await treasury.write.setEngine([engine.address]);
        await funder.write.setEngine([engine.address]);
        await registry.write.setEngine([engine.address], { account: admin.account });

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [
                {
                    asset: usdc.address,
                    bankAdmin: admin.account.address,

                minBet: 1_000_000n,
                },
            ],
            { account: admin.account },
        );
        const cfg = await registry.read.getMarket([1]);
        const bank = await viem.getContractAt("BankVault4626", cfg.bank);

        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });

        // Red bet must have number==0; non-zero should revert.
        await expect(
            bank.write.placeBet([parseUnits("1", 6), encodeSingleBet(8n, 1n, parseUnits("1", 6))], { account: alice.account }),
        ).to.be.rejected;
    });

    it("covers trio payout multiplier path end-to-end", async function () {
        const [admin, alice] = await viem.getWalletClients();
        const publicClient = await viem.getPublicClient();

        const usdc = await viem.deployContract("MockUSDC");
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine, scheduler } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                registry.address,
                treasury.address,
                funder.address,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                500,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 10, maxPayoutsPerCall: 10 },
        );
        await treasury.write.setEngine([engine.address]);
        await funder.write.setEngine([engine.address]);
        await registry.write.setEngine([engine.address], { account: admin.account });

        const vaultImpl = await viem.deployContract("BankVault4626");
        const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, admin.account.address]);
        await registry.write.setVaultBeacon([beacon.address], { account: admin.account });
        await registry.write.createMarket(
            [
                {
                    asset: usdc.address,
                    bankAdmin: admin.account.address,

                minBet: 1_000_000n,
                },
            ],
            { account: admin.account },
        );
        const cfg = await registry.read.getMarket([1]);
        const bank = await viem.getContractAt("BankVault4626", cfg.bank);

        // Liquidity to pay winners.
        await usdc.write.mint([admin.account.address, parseUnits("1000", 6)]);
        await usdc.write.approve([bank.address, parseUnits("1000", 6)], { account: admin.account });
        await bank.write.deposit([parseUnits("500", 6), admin.account.address], { account: admin.account });

        // Place a Trio 0-1-2 bet; winningNumber=1 should make it win with 12x.
        const betAmount = parseUnits("10", 6);
        await usdc.write.mint([alice.account.address, parseUnits("100", 6)]);
        await usdc.write.approve([bank.address, parseUnits("100", 6)], { account: alice.account });
        const trio012 = encodeSingleBet(14n, 0n, betAmount);
        const before = await usdc.read.balanceOf([alice.account.address]);
        await bank.write.placeBet([betAmount, trio012], { account: alice.account });

        await time.increase(550);
        const [, preLockData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([preLockData]);
        const [, vrfData] = await scheduler.read.checkUpkeep(["0x"]);
        await scheduler.write.performUpkeep([vrfData]);
        await vrf.write.fulfillWithJackpot([engine.address, 1n, 1n, 2n]);

        // Payout
        const [, payoutData] = await scheduler.read.checkUpkeep(["0x"]);
        const gas = await publicClient.estimateContractGas({
            address: scheduler.address,
            abi: scheduler.abi,
            functionName: "performUpkeep",
            args: [payoutData],
            account: alice.account,
        });
        expect(gas).to.be.lt(2_500_000n);
        await scheduler.write.performUpkeep([payoutData]);

        const after = await usdc.read.balanceOf([alice.account.address]);
        expect(after).to.equal(before - betAmount + betAmount * 12n);
    });

    it("enforces granular roles for engine configuration", async function () {
        const [admin, payoutAdmin, stranger] = await viem.getWalletClients();
        const registry = await viem.deployContract("MarketRegistry", [admin.account.address]);
        const vrf = await viem.deployContract("MockVrfCoordinator");
        const brb = await viem.deployContract("BRBToken", [admin.account.address]);
        const treasury = await viem.deployContract("JackpotTreasury", [brb.address, admin.account.address]);
        const router = await viem.deployContract("MockUniswapV2Router");
        const funder = await viem.deployContract("BRBJackpotFunder", [
            "0x0000000000000000000000000000000000000000",
            brb.address,
            router.address,
            treasury.address,
            admin.account.address,
        ]);
        const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
        const { engine } = await deployRouletteEngine(
            [mockLaneKey, mockLaneKey, mockLaneKey],
            [
                registry.address,
                treasury.address,
                funder.address,
                admin.account.address,
                vrf.address,
                1n,
                2_000_000,
                1,
                60,
                admin.account.address,
            ],
            { admin: admin.account.address, scanLimit: 25, maxPayoutsPerCall: 10 },
        );

        const enginePayoutRole = await engine.read.ENGINE_PAYOUT_ROLE();
        await engine.write.grantRole([enginePayoutRole, payoutAdmin.account.address], { account: admin.account });

        expect(await engine.read.ROUND_DURATION()).to.equal(60);
        await engine.write.setRoundDuration([120], { account: admin.account });
        expect(await engine.read.ROUND_DURATION()).to.equal(120);

        await expect(engine.write.setRoundDuration([0], { account: admin.account })).to.be.rejected;
        await expect(engine.write.setRoundDuration([90], { account: stranger.account })).to.be.rejected;
        await expect(engine.write.setRoundDuration([100], { account: payoutAdmin.account })).to.be.rejected;

        await engine.write.setPayoutLaneCount([5], { account: payoutAdmin.account });
        expect(await engine.read.payoutParallelLaneCount()).to.equal(5);
        await expect(engine.write.setPayoutLaneCount([3], { account: stranger.account })).to.be.rejected;
    });
});

function vaultInitData(
    asset: Address,
    name: string,
    symbol: string,
    marketId: number,
    engine: Address,
    admin: Address,
    minBet: bigint,
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
                name,
                symbol,
                marketId,
                engine,
                admin,
                minBet,
            },
        ],
    });
}

