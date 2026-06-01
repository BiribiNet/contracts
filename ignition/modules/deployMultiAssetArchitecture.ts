import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { keccak256, toBytes } from "viem";

const SETTLEMENT_ROLE = keccak256(toBytes("SETTLEMENT_ROLE"));

/**
 * `RouletteEngine` is wired to a single immutable `UpkeepScheduler` address at construction.
 * Pass the predicted scheduler CREATE address via deployment parameters (see
 * `predictRouletteStackAddresses` in `scripts/utils/predictDeployAddresses.ts`).
 *
 * `engineProxy` and `sideBetProxy` must match the CREATE nonces from
 * treasury → funder → registry → linked libraries → engine stack deployment.
 */
const DeployMultiAssetArchitectureModule = buildModule("DeployMultiAssetArchitecture", (m) => {
    const admin = m.getAccount(0);

    const mockVrf = m.contract("MockVrfCoordinator");
    const mockLink = m.contract("MockLinkToken");
    const assetA = m.contract("MockUSDC");
    const assetB = m.contract("MockUSDC");
    const brb = m.contract("BRBToken", [admin]);
    const mockRouter = m.contract("MockUniswapV2Router");

    const engineProxy = m.getParameter("engineProxy", "0x0000000000000000000000000000000000000000");
    const sideBetProxy = m.getParameter("sideBetProxy", "0x0000000000000000000000000000000000000000");
    const upkeepScheduler = m.getParameter("upkeepScheduler", "0x0000000000000000000000000000000000000000");

    const jackpotTreasury = m.contract("JackpotTreasury", [brb, engineProxy, admin]);
    const funder = m.contract("BRBJackpotFunder", [engineProxy, brb, mockRouter, jackpotTreasury, sideBetProxy, admin]);
    const registry = m.contract("MarketRegistry", [admin, engineProxy, sideBetProxy]);

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

    const engine = m.contract(
        "RouletteEngine",
        [
            registry,
            jackpotTreasury,
            funder,
            admin,
            mockVrf,
            1n,
            {
                keyHash2Gwei: "0x1111111111111111111111111111111111111111111111111111111111111111",
                keyHash30Gwei: "0x1111111111111111111111111111111111111111111111111111111111111111",
                keyHash150Gwei: "0x1111111111111111111111111111111111111111111111111111111111111111",
            },
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

    const sideBetImpl = m.contract("SideBet", [], { id: "SideBetImpl", after: [engine] });
    const sideBetInit = m.encodeFunctionCall(sideBetImpl, "initialize", [admin, engine, registry, 50_000, 5_000_000]);
    const sideBet = m.contract("ERC1967Proxy", [sideBetImpl, sideBetInit], { id: "SideBet", after: [sideBetImpl] });

    const scheduler = m.contract("UpkeepScheduler", [engine, sideBet, admin, 25, 60], {
        id: "UpkeepScheduler",
        after: [sideBet],
    });
    const upkeepManager = m.contract("UpkeepManager", [mockLink, admin, admin, scheduler, admin, admin]);
    m.call(scheduler, "setForwarderAuthority", [upkeepManager]);
    m.call(sideBet, "grantRole", [SETTLEMENT_ROLE, scheduler], { after: [scheduler] });

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
        sideBet,
        scheduler,
        upkeepManager,
        vaultImpl,
        vaultBeacon,
    };
});

export default DeployMultiAssetArchitectureModule;
