import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * `RouletteEngine` is wired to a single immutable `UpkeepScheduler` address at construction.
 * Pass the predicted scheduler CREATE address via deployment parameters (see
 * `predictUpkeepSchedulerAddress` in `scripts/utils/deployRouletteEngine.ts`: one CREATE after the engine).
 */
const DeployMultiAssetArchitectureModule = buildModule("DeployMultiAssetArchitecture", (m) => {
    const admin = m.getAccount(0);

    const mockVrf = m.contract("MockVrfCoordinator");
    const mockLink = m.contract("MockLinkToken");
    const assetA = m.contract("MockUSDC");
    const assetB = m.contract("MockUSDC");
    const brb = m.contract("BRBToken", [admin]);
    const jackpotTreasury = m.contract("JackpotTreasury", [brb, admin]);
    const mockRouter = m.contract("MockUniswapV2Router");
    const funder = m.contract("BRBJackpotFunder", [
        "0x0000000000000000000000000000000000000000",
        brb,
        mockRouter,
        jackpotTreasury,
        admin,
    ]);

    const registry = m.contract("MarketRegistry", [admin]);

    const rouletteLib = m.library("RouletteLib");
    const rouletteBetLib = m.library("RouletteBetLib");
    const jackpotBatchLib = m.library("JackpotBatchLib");
    const roulettePayoutMulLib = m.library("RoulettePayoutMulLib");

    const rouletteLiabilityMathLib = m.library("RouletteLiabilityMathLib", [], {
        libraries: {
            RouletteLib: rouletteLib,
        },
    });

    const rouletteBetCodecLib = m.library("RouletteBetCodecLib", [], {
        libraries: {
            RouletteBetLib: rouletteBetLib,
        },
    });

    const upkeepScheduler = m.getParameter("upkeepScheduler", "0x0000000000000000000000000000000000000000");

    const mockVrfLaneKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const vrfLaneKeys = {
        keyHash2Gwei: mockVrfLaneKey,
        keyHash30Gwei: mockVrfLaneKey,
        keyHash150Gwei: mockVrfLaneKey,
    };

    const engine = m.contract(
        "RouletteEngine",
        [
            registry,
            jackpotTreasury,
            funder,
            admin,
            mockVrf,
            1n,
            vrfLaneKeys,
            2_000_000,
            1,
            60,
            admin,
            upkeepScheduler,
        ],
        {
            libraries: {
                RouletteBetLib: rouletteBetLib,
                JackpotBatchLib: jackpotBatchLib,
                RouletteBetCodecLib: rouletteBetCodecLib,
                RoulettePayoutMulLib: roulettePayoutMulLib,
                RouletteLiabilityMathLib: rouletteLiabilityMathLib,
            },
        },
    );

    m.call(jackpotTreasury, "setEngine", [engine]);
    m.call(funder, "setEngine", [engine]);
    m.call(registry, "setEngine", [engine]);

    const scheduler = m.contract("UpkeepScheduler", [engine, admin, 25, 60], { id: "UpkeepScheduler" });
    const upkeepManager = m.contract("UpkeepManager", [mockLink, admin, admin, scheduler, admin, admin]);
    m.call(scheduler, "setForwarderAuthority", [upkeepManager]);

    const vaultImpl = m.contract("BankVault4626", [], { after: [upkeepManager] });
    const vaultBeacon = m.contract("UpgradeableBeacon", [vaultImpl, admin], { after: [vaultImpl] });
    m.call(registry, "setVaultBeacon", [vaultBeacon]);

    m.call(registry, "createMarket", [
        {
            asset: assetA,
            bankAdmin: admin,
            minBet: 1n,
        },
    ]);
    m.call(registry, "createMarket", [
        {
            asset: assetB,
            bankAdmin: admin,
            minBet: 1n,
        },
    ]);

    return {
        mockVrf,
        mockLink,
        brb,
        mockRouter,
        jackpotTreasury,
        funder,
        registry,
        engine,
        scheduler,
        upkeepManager,
        vaultImpl,
        vaultBeacon,
    };
});

export default DeployMultiAssetArchitectureModule;
