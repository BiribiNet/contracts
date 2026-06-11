import "dotenv/config";

import { viem } from "hardhat";
import { isAddress, maxUint256, parseAbi, parseUnits } from "viem";

import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import { zeroAddress } from "viem";

/** Treat unset, blank, literal "null" / "undefined" as no address → deploy mocks. */
function optionalAddressEnv(name: string, raw: string | undefined): `0x${string}` | undefined {
    if (raw === undefined) return undefined;
    const v = raw.trim();
    if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "undefined") return undefined;
    if (!isAddress(v)) throw new Error(`${name} must be a valid 0x address or empty / null for mock deployment: ${raw}`);
    return v;
}

async function main() {
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const vrfCoordinator = process.env.VRF_COORDINATOR as `0x${string}` | undefined;
    const linkToken = process.env.LINK_TOKEN as `0x${string}` | undefined;
    const keeperRegistrar = process.env.KEEPER_REGISTRAR as `0x${string}` | undefined;
    const keeperRegistry = process.env.KEEPER_REGISTRY as `0x${string}` | undefined;
    const assetAAddress = optionalAddressEnv("ASSET_A_TOKEN", process.env.ASSET_A_TOKEN);
    const assetBAddress = optionalAddressEnv("ASSET_B_TOKEN", process.env.ASSET_B_TOKEN);
    const infraRecipient = (process.env.INFRA_RECIPIENT as `0x${string}` | undefined) ?? deployer.account.address;
    const brbAddressEnv = process.env.BRB_TOKEN as `0x${string}` | undefined;
    const routerAddressEnv = process.env.UNISWAP_V2_ROUTER as `0x${string}` | undefined;

    if (!vrfCoordinator || !linkToken || !keeperRegistrar || !keeperRegistry) {
        throw new Error(
            "Missing env vars. Required: VRF_COORDINATOR, LINK_TOKEN, KEEPER_REGISTRAR, KEEPER_REGISTRY. For assets: set both ASSET_A_TOKEN and ASSET_B_TOKEN to real addresses, or leave both unset / empty / null to deploy MockUSDC + MockDAI. Optional: INFRA_RECIPIENT (defaults to deployer), BRB_TOKEN (deployed if unset), UNISWAP_V2_ROUTER (required when using mock assets; otherwise optional and a mock router is deployed if unset).",
        );
    }

    const usingMockAssets = !assetAAddress && !assetBAddress;
    if (Boolean(assetAAddress) !== Boolean(assetBAddress)) {
        throw new Error("Set both ASSET_A_TOKEN and ASSET_B_TOKEN, or omit both for mock USDC + mock DAI.");
    }
    if (usingMockAssets && !routerAddressEnv) {
        throw new Error("When omitting ASSET_A_TOKEN / ASSET_B_TOKEN, set UNISWAP_V2_ROUTER (testnet pool router you use).");
    }

    let assetA: `0x${string}`;
    let assetB: `0x${string}`;
    if (usingMockAssets) {
        const mockA = await viem.deployContract("MockUSDC");
        const mockB = await viem.deployContract("MockDAI");
        assetA = mockA.address;
        assetB = mockB.address;
    } else {
        assetA = assetAAddress as `0x${string}`;
        assetB = assetBAddress as `0x${string}`;
    }

    let brb: `0x${string}`;
    if (brbAddressEnv) {
        brb = brbAddressEnv;
    } else {
        const brbC = await viem.deployContract("BRBToken", [deployer.account.address]);
        brb = brbC.address;
    }

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

    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { engine, scheduler, registry, jackpotTreasury, funder } = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            zeroAddress,
            zeroAddress,
            zeroAddress,
            infraRecipient,
            vrfCoordinator,
            1n,
            2_000_000,
            3,
            60,
            deployer.account.address,
        ],
        {
            admin: deployer.account.address,
            scanLimit: 25,
            maxPayoutsPerCall: 60,
        },
        {
            protocolPrefix: {
                brb,
                mockRouter: router,
                admin: deployer.account.address,
            },
        },
    );

    await engine.write.setPayoutLaneCount([1], { account: deployer.account });

    const upkeepManager = await viem.deployContract("UpkeepManager", [
        linkToken,
        keeperRegistrar,
        keeperRegistry,
        scheduler.address,
        deployer.account.address,
        deployer.account.address,
    ]);

    await scheduler.write.setForwarderAuthority([upkeepManager.address]);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, deployer.account.address]);
    await registry.write.setVaultBeacon([beacon.address]);

    const minAssetA = parseUnits("1", 6);
    const minAssetB = parseUnits("1", 18);

    await registry.write.createMarket([
        {
            asset: assetA,
            bankAdmin: deployer.account.address,
            minBet: minAssetA,
        },
    ]);
    await registry.write.createMarket([
        {
            asset: assetB,
            bankAdmin: deployer.account.address,
            minBet: minAssetB,
        },
    ]);

    const marketA = await registry.read.getMarket([1]);
    const marketB = await registry.read.getMarket([2]);

    if (deployedMockRouter && !brbAddressEnv) {
        const brbContract = await viem.getContractAt("BRBToken", brb);
        await brbContract.write.transfer([router, parseUnits("1000000", 18)]);
    }

    const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);
    const approveHash = await deployer.writeContract({
        address: linkToken,
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [upkeepManager.address, maxUint256],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    await upkeepManager.write.registerLaneUpkeep([0n, 1_800_000, parseUnits("1", 18), deployer.account.address]);

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
        ...(usingMockAssets ? { mockUsdc: assetA, mockDai: assetB } : { assetA, assetB }),
        assetABank: marketA.bank,
        assetBBank: marketB.bank,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
