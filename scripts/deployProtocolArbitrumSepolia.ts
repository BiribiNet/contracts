import "dotenv/config";

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { isAddress, maxUint256, parseAbi, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import { deployUniswapV2Local } from "./utils/deployUniswapV2Local";
import { vrfAddConsumerIfNeeded, vrfCreateSubscription, vrfFundSubscriptionWithLink } from "./utils/vrfSubscription";
import { verifyContractWithDelay, verifyRouletteEngineImplementation } from "./utils/verifyWithEtherscan";

/**
 * Full protocol deploy for Arbitrum Sepolia (chain 421614): local Uniswap V2 (factory + WETH + router),
 * then RouletteEngine stack, three markets (USDC, DAI or mock DAI, BRB), jackpot, upkeep manager + one automation lane (lane 0).
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` and `hardhat vars set ARBITRUM_SEPOLIA_RPC_URL` (see hardhat.network.ts)
 * - `hardhat vars set ETHERSCAN_API_KEY` for Arbiscan verification (same key as Etherscan v2 API)
 * - LINK on deployer for `registerLaneUpkeep`
 * - Arbitrum Sepolia ETH for gas
 *
 * Run: `yarn deploy:protocol:arbitrum-sepolia`
 *
 * Uniswap: unless `UNISWAP_V2_ROUTER` is set, deploys vendored Uniswap V2 (`contracts/vendor/…`) and uses that router.
 * Set `SKIP_UNISWAP_DEPLOY=true` and `UNISWAP_V2_ROUTER` together only if you already have a router.
 *
 * VRF: same flow as Ethereum Sepolia script — optional `VRF_SUBSCRIPTION_ID`, `VRF_INITIAL_LINK_JUELS`.
 *
 * Env (optional overrides):
 * - VERIFY_CONTRACTS: default true when `ETHERSCAN_API_KEY` is set; set `false` to skip
 * - VERIFY_DELAY_MS: delay between Arbiscan API calls (default 8000)
 * - VRF_SUBSCRIPTION_ID, VRF_INITIAL_LINK_JUELS, LINK_TOKEN, VRF_COORDINATOR, KEEPER_REGISTRAR, KEEPER_REGISTRY
 * - VRF_KEY_HASH_2_GWEI, VRF_KEY_HASH_30_GWEI, VRF_KEY_HASH_150_GWEI (default: Arbitrum Sepolia 50 gwei lane for all three)
 * - USDC_TOKEN, DAI_TOKEN (omit DAI_TOKEN to deploy `MockDAI` for market 2)
 * - BRB_TOKEN, UNISWAP_V2_ROUTER, BRB_RATIO_MARKET_1, BRB_RATIO_MARKET_2
 * - INFRA_RECIPIENT, VRF_CALLBACK_GAS_LIMIT, VRF_CONFIRMATIONS, ROUND_DURATION_SECONDS
 */

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;

const DEFAULT_LINK = "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E" as const;
const DEFAULT_VRF_COORDINATOR = "0x50d47e4142598E3411aA864e08a44284e471AC6f" as const;
/** Arbitrum Sepolia VRF 50 gwei lane (public tutorials / Chainlink); override per lane with VRF_KEY_HASH_* if you use multiple lanes. */
const DEFAULT_VRF_KEY_HASH =
    "0x027f94ff1465b3525f9fc03e9ff7d6d2c0953482246dd6ae07570c45d6631414" as const;

/** Chainlink Automation on Arbitrum Sepolia (see docs.chain.link automation supported networks). */
const DEFAULT_KEEPER_REGISTRY = "0x8194399B3f11fcA2E8cCEfc4c9A658c61B8Bf412" as const;
const DEFAULT_KEEPER_REGISTRAR = "0x881918E24290084409DaA91979A30e6f0dB52eBe" as const;

/** Circle USDC on Arbitrum Sepolia — override with USDC_TOKEN if needed */
const DEFAULT_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;

const FQ_UNISWAP_FACTORY = "contracts/vendor/uniswap-v2-core/UniswapV2Factory.sol:UniswapV2Factory" as const;
const FQ_WETH9 = "contracts/vendor/uniswap-v2-periphery/test/WETH9.sol:WETH9" as const;
const FQ_UNISWAP_ROUTER = "contracts/vendor/uniswap-v2-periphery/UniswapV2Router02.sol:UniswapV2Router02" as const;

function optionalAddressEnv(name: string, raw: string | undefined): `0x${string}` | undefined {
    if (raw === undefined) return undefined;
    const v = raw.trim();
    if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "undefined") return undefined;
    if (!isAddress(v)) throw new Error(`${name} must be a valid 0x address or empty: ${raw}`);
    return v;
}

function envAddressOrDefault(name: string, fallback: `0x${string}`): `0x${string}` {
    return optionalAddressEnv(name, process.env[name]) ?? fallback;
}

function envBigIntOr(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    try {
        return BigInt(raw);
    } catch {
        throw new Error(`${name} must be an integer decimal string: ${raw}`);
    }
}

function envBytes32Or(name: string, fallback: `0x${string}`): `0x${string}` {
    const raw = process.env[name]?.trim();
    if (!raw || raw.toLowerCase() === "null") return fallback;
    if (!raw.startsWith("0x") || raw.length !== 66) {
        throw new Error(`${name} must be a bytes32 hex string: 0x followed by 64 hex characters`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(`${name} must be hex: ${raw}`);
    }
    return raw as `0x${string}`;
}

function vrfKeyHashTriple(): readonly [`0x${string}`, `0x${string}`, `0x${string}`] {
    const laneDefault = DEFAULT_VRF_KEY_HASH;
    return [
        envBytes32Or("VRF_KEY_HASH_2_GWEI", laneDefault),
        envBytes32Or("VRF_KEY_HASH_30_GWEI", laneDefault),
        envBytes32Or("VRF_KEY_HASH_150_GWEI", laneDefault),
    ] as const;
}

function envBool(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === "") return defaultValue;
    if (raw === "1" || raw === "true" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "no") return false;
    throw new Error(`${name} must be true/false (got ${process.env[name]})`);
}

async function main() {
    const publicClient = await viem.getPublicClient();
    const walletClients = await viem.getWalletClients();
    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
        throw new Error(`This script targets Arbitrum Sepolia (421614). Current chainId: ${chainId}`);
    }

    const waitWrite = async (hashPromise: Promise<`0x${string}`>) => {
        const hash = await hashPromise;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
            throw new Error(`Transaction reverted (hash ${hash})`);
        }
    };

    const [deployer] = walletClients;
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const deployerWei = await publicClient.getBalance({ address: deployer.account.address });
    if (deployerWei === 0n) {
        throw new Error(
            "Deployer Arbitrum Sepolia ETH balance is 0 — fund it for gas. Many RPCs return `gas required exceeds allowance (0)` on eth_estimateGas when the sender cannot pay.",
        );
    }

    const verifyDelayMs = Number(envBigIntOr("VERIFY_DELAY_MS", 8000n));
    const wantVerify = envBool("VERIFY_CONTRACTS", vars.has("ETHERSCAN_API_KEY"));
    const runVerify = wantVerify && vars.has("ETHERSCAN_API_KEY");
    if (wantVerify && !vars.has("ETHERSCAN_API_KEY")) {
        console.warn("VERIFY_CONTRACTS requested but ETHERSCAN_API_KEY is not set — skipping verification.");
    }

    const vrfCoordinator = envAddressOrDefault("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);
    const linkToken = envAddressOrDefault("LINK_TOKEN", DEFAULT_LINK);
    const keeperRegistrar = envAddressOrDefault("KEEPER_REGISTRAR", DEFAULT_KEEPER_REGISTRAR);
    const keeperRegistry = envAddressOrDefault("KEEPER_REGISTRY", DEFAULT_KEEPER_REGISTRY);
    const usdc = envAddressOrDefault("USDC_TOKEN", DEFAULT_USDC);
    const daiEnv = optionalAddressEnv("DAI_TOKEN", process.env.DAI_TOKEN);

    const routerFromEnv = optionalAddressEnv("UNISWAP_V2_ROUTER", process.env.UNISWAP_V2_ROUTER);
    const skipUniswap = envBool("SKIP_UNISWAP_DEPLOY", false);
    if (skipUniswap && !routerFromEnv) {
        throw new Error("SKIP_UNISWAP_DEPLOY=true requires UNISWAP_V2_ROUTER.");
    }

    let router: `0x${string}`;
    let uniswapDeployed: { factory: `0x${string}`; weth: `0x${string}`; router: `0x${string}` } | undefined;
    if (routerFromEnv) {
        router = routerFromEnv;
    } else {
        uniswapDeployed = await deployUniswapV2Local(deployer);
        router = uniswapDeployed.router;
        console.log("Deployed local Uniswap V2:", uniswapDeployed);
    }

    const brbAddressEnv = optionalAddressEnv("BRB_TOKEN", process.env.BRB_TOKEN);
    const infraRecipient = (process.env.INFRA_RECIPIENT as `0x${string}` | undefined) ?? deployer.account.address;

    const vrfSubFromEnv = envBigIntOr("VRF_SUBSCRIPTION_ID", 0n);
    let vrfSubscriptionId: bigint;
    let vrfSubscriptionCreatedByScript = false;
    if (vrfSubFromEnv !== 0n) {
        vrfSubscriptionId = vrfSubFromEnv;
    } else {
        vrfSubscriptionId = await vrfCreateSubscription(deployer, publicClient, vrfCoordinator);
        vrfSubscriptionCreatedByScript = true;
        console.log(`Created VRF subscription id: ${vrfSubscriptionId.toString()}`);
    }

    const vrfInitialLinkJuels = envBigIntOr("VRF_INITIAL_LINK_JUELS", 0n);
    if (vrfInitialLinkJuels > 0n) {
        await vrfFundSubscriptionWithLink(deployer, publicClient, linkToken, vrfCoordinator, vrfSubscriptionId, vrfInitialLinkJuels);
        console.log(`Funded VRF subscription with ${vrfInitialLinkJuels.toString()} Juels LINK`);
    }
    const [vrfKeyHash2Gwei, vrfKeyHash30Gwei, vrfKeyHash150Gwei] = vrfKeyHashTriple();
    const callbackGasLimit = Number(envBigIntOr("VRF_CALLBACK_GAS_LIMIT", 2_500_000n));
    const confirmations = Number(envBigIntOr("VRF_CONFIRMATIONS", 1n));
    const roundDuration = Number(envBigIntOr("ROUND_DURATION_SECONDS", 60n));

    let brb: `0x${string}`;
    let deployedBrb = false;
    if (brbAddressEnv) {
        brb = brbAddressEnv;
    } else {
        const brbC = await viem.deployContract("BRBToken", [deployer.account.address]);
        brb = brbC.address;
        deployedBrb = true;
    }

    let dai: `0x${string}`;
    let deployedMockDai = false;
    if (daiEnv) {
        dai = daiEnv;
    } else {
        const mockDai = await viem.deployContract("MockDAI");
        dai = mockDai.address;
        deployedMockDai = true;
        console.log("Deployed MockDAI for market 2 (set DAI_TOKEN to use an existing Arbitrum Sepolia DAI).");
    }

    const { engine, engineImplementation, scheduler, linkedLibraries, brbReferral: deployedBrbReferral, registry, jackpotTreasury, funder } =
        await deployRouletteEngine(
        [vrfKeyHash2Gwei, vrfKeyHash30Gwei, vrfKeyHash150Gwei],
        [
            zeroAddress,
            zeroAddress,
            zeroAddress,
            infraRecipient,
            vrfCoordinator,
            vrfSubscriptionId,
            callbackGasLimit,
            confirmations,
            roundDuration,
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
            deployBrbReferral: true,
        },
    );

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, deployer.account.address]);
    await waitWrite(registry.write.setVaultBeacon([beacon.address], { account: deployer.account }));
    const vaultBeaconOnChain = await registry.read.vaultBeacon();
    if (vaultBeaconOnChain.toLowerCase() !== beacon.address.toLowerCase()) {
        throw new Error(
            `setVaultBeacon did not persist: registry has ${vaultBeaconOnChain}, expected beacon ${beacon.address}. Check deployer is registry admin.`,
        );
    }

    await vrfAddConsumerIfNeeded(deployer, publicClient, vrfCoordinator, vrfSubscriptionId, engine.address);

    await waitWrite(engine.write.setPayoutLaneCount([1], { account: deployer.account }));

    const upkeepManager = await viem.deployContract("UpkeepManager", [
        linkToken,
        keeperRegistrar,
        keeperRegistry,
        scheduler.address,
        deployer.account.address,
        deployer.account.address,
    ]);

    const schedulerForwarderAbi = parseAbi([
        "function setForwarderAuthority(address forwarderAuthority) external",
    ]);
    await waitWrite(
        deployer.writeContract({
            address: scheduler.address,
            abi: schedulerForwarderAbi,
            functionName: "setForwarderAuthority",
            args: [upkeepManager.address],
            account: deployer.account,
            chain: publicClient.chain,
        }),
    );

    const minStable = parseUnits("1", 6);
    const minBrb = parseUnits("1", 18);

    await waitWrite(
        registry.write.createMarket(
            [
                {
                    asset: usdc,
                    bankAdmin: deployer.account.address,


                                                    minBet: minStable,
                },
            ],
            { account: deployer.account },
        ),
    );
    await waitWrite(
        registry.write.createMarket(
            [
                {
                    asset: dai,
                    bankAdmin: deployer.account.address,


                                                    minBet: minStable,
                },
            ],
            { account: deployer.account },
        ),
    );
    await waitWrite(
        registry.write.createMarket(
            [
                {
                    asset: brb,
                    bankAdmin: deployer.account.address,


                                                    minBet: minBrb,
                },
            ],
            { account: deployer.account },
        ),
    );

    /** Some Arbitrum Sepolia RPCs briefly serve stale state after receipts; avoid spurious `InvalidMarketId` on `getMarket`. */
    const waitMarketCountAtLeast = async (min: number) => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            const n = Number(await registry.read.marketCount());
            if (n >= min) return;
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error(`Timed out waiting for registry.marketCount() >= ${min}`);
    };
    await waitMarketCountAtLeast(3);


    const marketUsdc = await registry.read.getMarket([1]);
    const marketDai = await registry.read.getMarket([2]);
    const marketBrb = await registry.read.getMarket([3]);

    const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);
    await waitWrite(
        deployer.writeContract({
            address: linkToken,
            abi: erc20ApproveAbi,
            functionName: "approve",
            args: [upkeepManager.address, maxUint256],
            account: deployer.account,
            chain: publicClient.chain,
        }),
    );

    const upkeepGasLimit = 1_800_000;
    const upkeepFundAmount = parseUnits("1", 18);
    await waitWrite(
        upkeepManager.write.registerLaneUpkeep([0n, upkeepGasLimit, upkeepFundAmount, deployer.account.address]),
    );

    const deployBlock = Number(await publicClient.getBlockNumber());
    const brbReferal =
        optionalAddressEnv("BRB_REFERRAL_TOKEN", process.env.BRB_REFERRAL_TOKEN) ?? deployedBrbReferral;

    const subgraphDeployment = {
        startBlock: deployBlock,
        startBlocks: {
            brb: deployBlock,
            roulette: deployBlock,
            stakedBRB: deployBlock,
            brbReferal: deployBlock,
        },
        addresses: {
            brb,
            roulette: engine.address,
            stakedBRB: marketUsdc.bank,
            banks: [marketUsdc.bank, marketDai.bank, marketBrb.bank],
            brbReferal,
            upkeepManager: upkeepManager.address,
            jackpotTreasury: jackpotTreasury.address,
        },
    };

    const contractsRoot = join(__dirname, "..");
    const subgraphRoot = join(contractsRoot, "..", "subgraph");
    const deployJsonPath = join(subgraphRoot, "deployments", "arbitrum-sepolia.json");
    writeFileSync(deployJsonPath, `${JSON.stringify(subgraphDeployment, null, 2)}\n`, "utf8");
    console.log(`Wrote subgraph deployment manifest: ${deployJsonPath}`);

    const abiSync = spawnSync("yarn", ["update:subgraph:abis"], {
        cwd: contractsRoot,
        stdio: "inherit",
        shell: true,
    });
    if (abiSync.status !== 0) {
        throw new Error("yarn update:subgraph:abis failed");
    }

    if (!envBool("SKIP_SUBGRAPH_SYNC", false)) {
        const pipeline = spawnSync("yarn", ["sync:pipeline"], {
            cwd: subgraphRoot,
            stdio: "inherit",
            shell: true,
            env: {
                ...process.env,
                DEPLOY_JSON: "./deployments/arbitrum-sepolia.json",
            },
        });
        if (pipeline.status !== 0) {
            throw new Error("subgraph sync:pipeline failed (set SKIP_SUBGRAPH_SYNC=true to skip)");
        }
    } else {
        console.log("SKIP_SUBGRAPH_SYNC=true — skipped Goldsky turbo + subgraph deploy.");
    }

    if (runVerify) {
        console.log("Starting Arbiscan verification…");
        if (uniswapDeployed) {
            await verifyContractWithDelay(uniswapDeployed.factory, [deployer.account.address], verifyDelayMs, FQ_UNISWAP_FACTORY);
            await verifyContractWithDelay(uniswapDeployed.weth, [], verifyDelayMs, FQ_WETH9);
            await verifyContractWithDelay(
                uniswapDeployed.router,
                [uniswapDeployed.factory, uniswapDeployed.weth],
                verifyDelayMs,
                FQ_UNISWAP_ROUTER,
            );
        }
        if (deployedBrb) {
            await verifyContractWithDelay(brb, [deployer.account.address], verifyDelayMs);
        }
        if (deployedMockDai) {
            await verifyContractWithDelay(dai, [], verifyDelayMs);
        }
        await verifyContractWithDelay(jackpotTreasury.address, [brb, deployer.account.address], verifyDelayMs);
        await verifyContractWithDelay(
            funder.address,
            [
                "0x0000000000000000000000000000000000000000",
                brb,
                router,
                jackpotTreasury.address,
                deployer.account.address,
            ],
            verifyDelayMs,
        );
        await verifyContractWithDelay(registry.address, [deployer.account.address], verifyDelayMs);
        await verifyContractWithDelay(vaultImpl.address, [], verifyDelayMs);
        await verifyContractWithDelay(beacon.address, [vaultImpl.address, deployer.account.address], verifyDelayMs);

        await verifyContractWithDelay(linkedLibraries.rouletteLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteBetLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.jackpotBatchLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.roulettePayoutMulLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteLiabilityMathLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteBetCodecLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.roulettePayoutSweepLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteJackpotCollectLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteExposureLib, [], verifyDelayMs);
        await verifyContractWithDelay(linkedLibraries.rouletteUpkeepScanLib, [], verifyDelayMs);

        const libraryMap: Record<string, string> = {
            "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": linkedLibraries.jackpotBatchLib,
            "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib": linkedLibraries.rouletteBetCodecLib,
            "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib": linkedLibraries.rouletteExposureLib,
            "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib":
                linkedLibraries.rouletteJackpotCollectLib,
            "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib":
                linkedLibraries.rouletteLiabilityMathLib,
            "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": linkedLibraries.roulettePayoutSweepLib,
            "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib": linkedLibraries.rouletteUpkeepScanLib,
        };
        try {
            await verifyRouletteEngineImplementation(
                engineImplementation.address,
                vrfCoordinator,
                libraryMap,
                verifyDelayMs,
            );
        } catch (e) {
            console.warn("RouletteEngine implementation verify failed (proxy may still be live):", e);
        }

        await verifyContractWithDelay(
            scheduler.address,
            [engine.address, deployer.account.address, 25, 60],
            verifyDelayMs,
        );
        await verifyContractWithDelay(
            upkeepManager.address,
            [
                linkToken,
                keeperRegistrar,
                keeperRegistry,
                scheduler.address,
                deployer.account.address,
                deployer.account.address,
            ],
            verifyDelayMs,
        );
        console.log("Verification pass complete.");
    }

    console.log("Arbitrum Sepolia protocol deployment complete");
    console.log(
        JSON.stringify(
            {
                chainId: Number(ARBITRUM_SEPOLIA_CHAIN_ID),
                subgraphDeployment,
                uniswap: uniswapDeployed
                    ? { ...uniswapDeployed, deployedLocally: true }
                    : { deployedLocally: false, router },
                registry: registry.address,
                vaultImpl: vaultImpl.address,
                vaultBeacon: beacon.address,
                engine: engine.address,
                scheduler: scheduler.address,
                linkedLibraries: {
                    rouletteLib: linkedLibraries.rouletteLib,
                    rouletteBetLib: linkedLibraries.rouletteBetLib,
                    jackpotBatchLib: linkedLibraries.jackpotBatchLib,
                    roulettePayoutMulLib: linkedLibraries.roulettePayoutMulLib,
                    rouletteLiabilityMathLib: linkedLibraries.rouletteLiabilityMathLib,
                    rouletteBetCodecLib: linkedLibraries.rouletteBetCodecLib,
                },
                upkeepManager: upkeepManager.address,
                jackpotTreasury: jackpotTreasury.address,
                brb,
                jackpotFunder: funder.address,
                uniswapRouter: router,
                markets: {
                    usdc: { marketId: 1, asset: usdc, bank: marketUsdc.bank },
                    dai: { marketId: 2, asset: dai, bank: marketDai.bank, mockDai: deployedMockDai },
                    brb: { marketId: 3, asset: brb, bank: marketBrb.bank },
                },
                vrf: {
                    coordinator: vrfCoordinator,
                    subscriptionId: vrfSubscriptionId.toString(),
                    subscriptionCreatedByScript: vrfSubscriptionCreatedByScript,
                    engineRegisteredAsConsumer: true,
                    keyHash2Gwei: vrfKeyHash2Gwei,
                    keyHash30Gwei: vrfKeyHash30Gwei,
                    keyHash150Gwei: vrfKeyHash150Gwei,
                },
                nextSteps: [
                    vrfSubscriptionCreatedByScript
                        ? "VRF subscription was created on-chain; fund it with LINK if you did not set VRF_INITIAL_LINK_JUELS (or use vrf.chain.link to top up)."
                        : "VRF subscription id was taken from VRF_SUBSCRIPTION_ID; ensure it is funded and the deployer is the subscription owner (required for addConsumer).",
                    "Fund each bank vault with initial liquidity; configure min bets / vault params as needed",
                    "Create BRB/USDC and BRB/DAI pools on your deployed Uniswap V2 router and tune BRB_RATIO_MARKET_1 / BRB_RATIO_MARKET_2 to match pool economics",
                ],
            },
            null,
            2,
        ),
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
