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
    const brbAddressEnv = process.env.BRB_TOKEN as `0x${string}` | undefined;
    const routerAddressEnv = process.env.UNISWAP_V2_ROUTER as `0x${string}` | undefined;

    if (!vrfCoordinator || !linkToken || !keeperRegistrar || !keeperRegistry || !assetAAddress || !assetBAddress || !infraRecipient) {
        throw new Error(
            "Missing env vars. Required: VRF_COORDINATOR, LINK_TOKEN, KEEPER_REGISTRAR, KEEPER_REGISTRY, ASSET_A_TOKEN, ASSET_B_TOKEN, INFRA_RECIPIENT. Optional: BRB_TOKEN, UNISWAP_V2_ROUTER (deployed if unset for local dev).",
        );
    }

    let brb: `0x${string}`;
    if (brbAddressEnv) {
        brb = brbAddressEnv;
    } else {
        const brbC = await viem.deployContract("BRBToken", [deployer.account.address]);
        brb = brbC.address;
    }

    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [brb, deployer.account.address]);

    let router: `0x${string}`;
    let deployedMockRouter: boolean;
    if (routerAddressEnv) {
        router = routerAddressEnv;
        deployedMockRouter = false;
    } else {
        const r = await viem.deployContract("MockUniswapV2Router");
        router = r.address;
        deployedMockRouter = true;
    }

    const funder = await viem.deployContract("BRBJackpotFunder", [
        "0x0000000000000000000000000000000000000000",
        brb,
        router,
        jackpotTreasury.address,
        deployer.account.address,
    ]);

    const registry = await viem.deployContract("MarketRegistry", [deployer.account.address]);
    const engine = await viem.deployContract("RouletteEngine", [
        registry.address,
        jackpotTreasury.address,
        funder.address,
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
    await funder.write.setEngine([engine.address]);
    await registry.write.setEngine([engine.address]);

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

    await scheduler.write.setForwarderAuthority([upkeepManager.address]);

    await engine.write.registerScheduler([scheduler.address, true]);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, deployer.account.address]);
    await registry.write.setVaultBeacon([beacon.address]);

    await registry.write.createMarket([
        {
            asset: assetAAddress,
            bankName: "Biribi Asset A Bank",
            bankSymbol: "bASA",
            bankAdmin: deployer.account.address,
        },
    ]);
    await registry.write.createMarket([
        {
            asset: assetBAddress,
            bankName: "Biribi Asset B Bank",
            bankSymbol: "bASB",
            bankAdmin: deployer.account.address,
        },
    ]);

    const marketA = await registry.read.getMarket([1]);
    const marketB = await registry.read.getMarket([2]);

    if (deployedMockRouter && !brbAddressEnv) {
        const brbContract = await viem.getContractAt("BRBToken", brb);
        await brbContract.write.transfer([router, parseUnits("1000000", 18)]);
    }

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
        brb,
        jackpotFunder: funder.address,
        uniswapRouter: router,
        assetABank: marketA.bank,
        assetBBank: marketB.bank,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
