import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

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
    const engine = m.contract("RouletteEngine", [
        registry,
        jackpotTreasury,
        funder,
        admin,
        mockVrf,
        1n,
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        2_000_000,
        1,
        60,
        admin,
    ]);
    m.call(jackpotTreasury, "setEngine", [engine]);
    m.call(funder, "setEngine", [engine]);
    m.call(registry, "setEngine", [engine]);

    const scheduler = m.contract("UpkeepScheduler", [engine, admin, 25, 60]);
    const upkeepManager = m.contract("UpkeepManager", [mockLink, admin, admin, scheduler, admin, admin]);
    m.call(scheduler, "setForwarderAuthority", [upkeepManager]);

    const vaultImpl = m.contract("BankVault4626");
    const vaultBeacon = m.contract("UpgradeableBeacon", [vaultImpl, admin]);
    m.call(registry, "setVaultBeacon", [vaultBeacon]);

    m.call(registry, "createMarket", [
        {
            asset: assetA,
            bankName: "Biribi Asset A Bank",
            bankSymbol: "bASA",
            bankAdmin: admin,
        },
    ]);
    m.call(registry, "createMarket", [
        {
            asset: assetB,
            bankName: "Biribi Asset B Bank",
            bankSymbol: "bASB",
            bankAdmin: admin,
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
