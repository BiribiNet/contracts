import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const DeployMultiAssetArchitectureModule = buildModule("DeployMultiAssetArchitecture", (m) => {
    const admin = m.getAccount(0);

    // Local/dev defaults. Replace these parameters per network at deploy time.
    const mockVrf = m.contract("MockVrfCoordinator");
    const mockLink = m.contract("MockLinkToken");
    const assetA = m.contract("MockUSDC");
    const assetB = m.contract("MockUSDC");
    const jackpotTreasury = m.contract("JackpotTreasury", [admin]);

    const registry = m.contract("MarketRegistry", [admin]);
    const engine = m.contract("RouletteEngine", [
        registry,
        jackpotTreasury,
        admin,
        mockVrf,
        1n,
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        2_000_000,
        1,
        60,
        admin,
    ]);
    const scheduler = m.contract("UpkeepScheduler", [engine, admin, 25, 60]);
    const upkeepManager = m.contract("UpkeepManager", [mockLink, admin, admin, scheduler, admin, admin]);

    const assetABank = m.contract("BankVault4626", [assetA, "Biribi Asset A Bank", "bASA", 1, engine, admin]);
    const assetBBank = m.contract("BankVault4626", [assetB, "Biribi Asset B Bank", "bASB", 2, engine, admin]);
    m.call(jackpotTreasury, "setEngine", [engine]);

    return {
        mockVrf,
        mockLink,
        jackpotTreasury,
        registry,
        engine,
        scheduler,
        upkeepManager,
        assetABank,
        assetBBank,
    };
});

export default DeployMultiAssetArchitectureModule;
