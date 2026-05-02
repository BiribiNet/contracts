import { viem } from "hardhat";
import { parseUnits } from "viem";

async function main() {
    const [deployer] = await viem.getWalletClients();

    const vrfCoordinator = process.env.VRF_COORDINATOR as `0x${string}` | undefined;
    const linkToken = process.env.LINK_TOKEN as `0x${string}` | undefined;
    const keeperRegistrar = process.env.KEEPER_REGISTRAR as `0x${string}` | undefined;
    const keeperRegistry = process.env.KEEPER_REGISTRY as `0x${string}` | undefined;
    const assetAAddress = process.env.ASSET_A_TOKEN as `0x${string}` | undefined;
    const assetBAddress = process.env.ASSET_B_TOKEN as `0x${string}` | undefined;
    const infraRecipient = process.env.INFRA_RECIPIENT as `0x${string}` | undefined;

    if (!vrfCoordinator || !linkToken || !keeperRegistrar || !keeperRegistry || !assetAAddress || !assetBAddress || !infraRecipient) {
        throw new Error(
            "Missing env vars. Required: VRF_COORDINATOR, LINK_TOKEN, KEEPER_REGISTRAR, KEEPER_REGISTRY, ASSET_A_TOKEN, ASSET_B_TOKEN, INFRA_RECIPIENT",
        );
    }

    const registry = await viem.deployContract("MarketRegistry", [deployer.account.address]);
    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [deployer.account.address]);
    const engine = await viem.deployContract("RouletteEngine", [
        registry.address,
        jackpotTreasury.address,
        infraRecipient,
        vrfCoordinator,
        1n,
        "0x" + "11".repeat(32),
        2_000_000,
        3,
        60,
        deployer.account.address,
    ]);
    await jackpotTreasury.write.setEngine([engine.address]);
    const scheduler = await viem.deployContract("UpkeepScheduler", [
        engine.address,
        deployer.account.address,
        25,
        60,
    ]);
    const upkeepManager = await viem.deployContract("UpkeepManager", [
        linkToken,
        keeperRegistrar,
        keeperRegistry,
        scheduler.address,
        deployer.account.address,
        deployer.account.address,
    ]);

    await engine.write.registerScheduler([scheduler.address, true]);

    const assetABank = await viem.deployContract("BankVault4626", [
        assetAAddress,
        "Biribi Asset A Bank",
        "bASA",
        1,
        engine.address,
        deployer.account.address,
    ]);
    const assetBBank = await viem.deployContract("BankVault4626", [
        assetBAddress,
        "Biribi Asset B Bank",
        "bASB",
        2,
        engine.address,
        deployer.account.address,
    ]);

    await registry.write.registerMarket([assetAAddress, assetABank.address, 60, 20_000]);
    await registry.write.registerMarket([assetBAddress, assetBBank.address, 60, 20_000]);
    await engine.write.registerMarket([1, assetABank.address]);
    await engine.write.registerMarket([2, assetBBank.address]);

    // Register 3 upkeep lanes by default (0..2).
    await upkeepManager.write.registerLaneUpkeep([0n, 1_800_000, parseUnits("1", 18), deployer.account.address]);
    await upkeepManager.write.registerLaneUpkeep([1n, 1_800_000, parseUnits("1", 18), deployer.account.address]);
    await upkeepManager.write.registerLaneUpkeep([2n, 1_800_000, parseUnits("1", 18), deployer.account.address]);

    console.log("Multi-asset deployment complete");
    console.log({
        registry: registry.address,
        engine: engine.address,
        scheduler: scheduler.address,
        upkeepManager: upkeepManager.address,
        jackpotTreasury: jackpotTreasury.address,
        assetABank: assetABank.address,
        assetBBank: assetBBank.address,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
