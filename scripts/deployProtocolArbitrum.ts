import "dotenv/config";

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { maxUint256, parseAbi, parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import { deployUniswapV2Local } from "./utils/deployUniswapV2Local";
import {
    envAddressOrDefault,
    envBigIntOr,
    envBool,
    optionalAddressEnv,
    vrfKeyHashTriple,
} from "./utils/protocolDeployEnv";
import { vrfAddConsumerIfNeeded, vrfCreateSubscription, vrfFundSubscriptionWithLink } from "./utils/vrfSubscription";
import {
    encodeBankVaultProxyInitDataFromAsset,
    verifyProtocolProxies,
} from "./utils/proxyVerification";
import {
    buildRouletteEngineLibraryMap,
    verifyContractWithDelay,
    verifyRouletteLinkedLibraries,
} from "./utils/verifyWithEtherscan";

/**
 * Production-oriented deploy for Arbitrum One (chain 42161).
 *
 * Run: `yarn deploy:protocol:arbitrum`
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` and `hardhat vars set ARBITRUM_RPC_URL`
 * - `UNISWAP_V2_ROUTER` — production Uniswap V2 compatible router (required unless `DEPLOY_LOCAL_UNISWAP=true`)
 * - `USDC_TOKEN`, `DAI_TOKEN`, optional `BRB_TOKEN` (omit to deploy new BRBToken to `PROTOCOL_ADMIN`)
 * - `PROTOCOL_ADMIN` — multisig receiving AccessControl roles (defaults to deployer)
 * - Funded VRF subscription (`VRF_SUBSCRIPTION_ID`) + LINK for Automation registration
 * - Verify Chainlink addresses on https://docs.chain.link before mainnet deploy
 *
 * Defaults (override via env): see Chainlink VRF v2.5 + Automation docs for Arbitrum One.
 */

const ARBITRUM_ONE_CHAIN_ID = 42161n;

const DEFAULT_LINK = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" as const;
/** VRF v2.5 coordinator — must match `VRFConsumerBaseV2` / subscription interface. */
const DEFAULT_VRF_COORDINATOR = "0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e" as const;
const DEFAULT_VRF_KEY_HASH_2_GWEI =
    "0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897" as const;
const DEFAULT_VRF_KEY_HASH_30_GWEI =
    "0x8472ba59cf7134dfe321f4d61a430c4857e8b19cdd5230b09952a92671c24409" as const;
const DEFAULT_VRF_KEY_HASH_150_GWEI =
    "0xe9f223d7d83ec85c4f78042a4845af3a1c8df7757b4997b815ce4b8d07aca68c" as const;

/** Chainlink Automation v2.1 on Arbitrum One — confirm on docs before production. */
const DEFAULT_KEEPER_REGISTRY = "0x87BD672Df456A85DE301FB87d477c8Bd39f76323" as const;
const DEFAULT_KEEPER_REGISTRAR = "0x98FBC1Aede4d27f8dE433C6c72BEC289ff9B2b15" as const;

const DEFAULT_USDC = "0xaf88d065e77c8cC2239327C2EDb1aB17869eD1BE" as const;
const DEFAULT_DAI = "0xDA10009cBd5D07dd0Cecc66161FC93D7c9000da1" as const;

const FQ_UNISWAP_FACTORY = "contracts/vendor/uniswap-v2-core/UniswapV2Factory.sol:UniswapV2Factory" as const;
const FQ_WETH9 = "contracts/vendor/uniswap-v2-periphery/test/WETH9.sol:WETH9" as const;
const FQ_UNISWAP_ROUTER = "contracts/vendor/uniswap-v2-periphery/UniswapV2Router02.sol:UniswapV2Router02" as const;

async function main() {
    const publicClient = await viem.getPublicClient();
    const walletClients = await viem.getWalletClients();
    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== 42161n) {
        throw new Error(`This script targets Arbitrum One (42161). Current chainId: ${chainId}`);
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

    const protocolAdmin =
        optionalAddressEnv("PROTOCOL_ADMIN", process.env.PROTOCOL_ADMIN) ?? deployer.account.address;
    const infraRecipient =
        optionalAddressEnv("INFRA_RECIPIENT", process.env.INFRA_RECIPIENT) ?? protocolAdmin;

    const deployLocalUniswap = envBool("DEPLOY_LOCAL_UNISWAP", false);
    const routerFromEnv = optionalAddressEnv("UNISWAP_V2_ROUTER", process.env.UNISWAP_V2_ROUTER);
    if (!deployLocalUniswap && !routerFromEnv) {
        throw new Error("Set UNISWAP_V2_ROUTER to a production router, or DEPLOY_LOCAL_UNISWAP=true for test only.");
    }

    let router: `0x${string}`;
    let uniswapDeployed: { factory: `0x${string}`; weth: `0x${string}`; router: `0x${string}` } | undefined;
    if (routerFromEnv) {
        router = routerFromEnv;
    } else {
        uniswapDeployed = await deployUniswapV2Local(deployer);
        router = uniswapDeployed.router;
        console.warn("DEPLOY_LOCAL_UNISWAP=true — not for production economics.");
    }

    const vrfCoordinator = envAddressOrDefault("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);
    const linkToken = envAddressOrDefault("LINK_TOKEN", DEFAULT_LINK);
    const keeperRegistrar = envAddressOrDefault("KEEPER_REGISTRAR", DEFAULT_KEEPER_REGISTRAR);
    const keeperRegistry = envAddressOrDefault("KEEPER_REGISTRY", DEFAULT_KEEPER_REGISTRY);
    const usdc = envAddressOrDefault("USDC_TOKEN", DEFAULT_USDC);
    const dai = envAddressOrDefault("DAI_TOKEN", DEFAULT_DAI);

    const vrfSubFromEnv = envBigIntOr("VRF_SUBSCRIPTION_ID", 0n);
    if (vrfSubFromEnv === 0n) {
        throw new Error("VRF_SUBSCRIPTION_ID is required on Arbitrum One (create at vrf.chain.link).");
    }
    const vrfSubscriptionId = vrfSubFromEnv;

    const vrfInitialLinkJuels = envBigIntOr("VRF_INITIAL_LINK_JUELS", 0n);
    if (vrfInitialLinkJuels > 0n) {
        await vrfFundSubscriptionWithLink(deployer, publicClient, linkToken, vrfCoordinator, vrfSubscriptionId, vrfInitialLinkJuels);
    }

    const vrfKeyHashes = vrfKeyHashTriple(DEFAULT_VRF_KEY_HASH_2_GWEI);
    const callbackGasLimit = Number(envBigIntOr("VRF_CALLBACK_GAS_LIMIT", 2_500_000n));
    const confirmations = Number(envBigIntOr("VRF_CONFIRMATIONS", 3n));
    const roundDuration = Number(envBigIntOr("ROUND_DURATION_SECONDS", 300n));
    const payoutLaneCount = Number(envBigIntOr("PAYOUT_LANE_COUNT", 1n));

    const brbAddressEnv = optionalAddressEnv("BRB_TOKEN", process.env.BRB_TOKEN);
    let brb: `0x${string}`;
    if (brbAddressEnv) {
        brb = brbAddressEnv;
    } else {
        const brbC = await viem.deployContract("BRBToken", [protocolAdmin]);
        brb = brbC.address;
        console.log(`Deployed BRBToken to ${brb} (minted to PROTOCOL_ADMIN)`);
    }

    const {
        engine,
        engineImplementation,
        engineProxyInitData,
        scheduler,
        linkedLibraries,
        brbReferral,
        registry,
        jackpotTreasury,
        funder,
        sideBet,
        sideBetImplementation,
        sideBetProxyInitData,
    } = await deployRouletteEngine(
            [vrfKeyHashes[0], vrfKeyHashes[1], vrfKeyHashes[2]],
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
                protocolAdmin,
            ],
            {
                admin: protocolAdmin,
                scanLimit: Number(envBigIntOr("UPKEEP_SCAN_LIMIT", 25n)),
                maxPayoutsPerCall: Number(envBigIntOr("UPKEEP_MAX_PAYOUTS_PER_CALL", 60n)),
            },
            {
                protocolPrefix: { brb, mockRouter: router, admin: protocolAdmin },
                deployBrbReferral: envBool("DEPLOY_BRB_REFERRAL", true),
            },
        );

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, protocolAdmin]);
    await waitWrite(registry.write.setVaultBeacon([beacon.address], { account: deployer.account }));

    await vrfAddConsumerIfNeeded(deployer, publicClient, vrfCoordinator, vrfSubscriptionId, engine.address);

    if (payoutLaneCount !== 1) {
        await waitWrite(engine.write.setPayoutLaneCount([payoutLaneCount], { account: deployer.account }));
    }

    const upkeepManager = await viem.deployContract("UpkeepManager", [
        linkToken,
        keeperRegistrar,
        keeperRegistry,
        scheduler.address,
        protocolAdmin,
        deployer.account.address,
    ]);

    const schedulerForwarderAbi = parseAbi(["function setForwarderAuthority(address forwarderAuthority) external"]);
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

    const minStable = parseUnits(process.env.MIN_BET_STABLE ?? "1", 6);
    const minDai = parseUnits(process.env.MIN_BET_DAI ?? "1", 18);
    const minBrb = parseUnits(process.env.MIN_BET_BRB ?? "1", 18);

    for (const params of [
        { asset: usdc, minBet: minStable },
        { asset: dai, minBet: minDai },
        { asset: brb, minBet: minBrb },
    ] as const) {
        await waitWrite(
            registry.write.createMarket(
                [{ asset: params.asset, bankAdmin: protocolAdmin, minBet: params.minBet }],
                { account: deployer.account },
            ),
        );
    }

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

    const upkeepGasLimit = Number(envBigIntOr("UPKEEP_GAS_LIMIT", 2_500_000n));
    const upkeepFundAmount = envBigIntOr("UPKEEP_LINK_FUND_JUELS", parseUnits("25", 18));
    const upkeepLaneCount = Number(envBigIntOr("UPKEEP_LANE_COUNT", BigInt(payoutLaneCount)));

    for (let lane = 0; lane < upkeepLaneCount; lane++) {
        await waitWrite(
            upkeepManager.write.registerLaneUpkeep(
                [BigInt(lane), upkeepGasLimit, upkeepFundAmount, protocolAdmin],
                { account: deployer.account },
            ),
        );
    }

    const deployBlock = Number(await publicClient.getBlockNumber());
    const deploymentManifest = {
        network: "arbitrum-one",
        chainId: 42161,
        startBlock: deployBlock,
        protocolAdmin,
        infraRecipient,
        addresses: {
            brb,
            brbReferal: brbReferral,
            registry: registry.address,
            engine: engine.address,
            engineImplementation: engineImplementation.address,
            sideBet: sideBet.address,
            scheduler: scheduler.address,
            upkeepManager: upkeepManager.address,
            jackpotTreasury: jackpotTreasury.address,
            jackpotFunder: funder.address,
            vaultImpl: vaultImpl.address,
            vaultBeacon: beacon.address,
            uniswapRouter: router,
            banks: [marketUsdc.bank, marketDai.bank, marketBrb.bank],
        },
        markets: {
            usdc: { marketId: 1, asset: usdc, bank: marketUsdc.bank },
            dai: { marketId: 2, asset: dai, bank: marketDai.bank },
            brb: { marketId: 3, asset: brb, bank: marketBrb.bank },
        },
        vrf: {
            coordinator: vrfCoordinator,
            subscriptionId: vrfSubscriptionId.toString(),
            keyHash2Gwei: vrfKeyHashes[0],
            keyHash30Gwei: vrfKeyHashes[1],
            keyHash150Gwei: vrfKeyHashes[2],
        },
    };

    const contractsRoot = join(__dirname, "..");
    const subgraphRoot = join(contractsRoot, "..", "subgraph");
    const deployJsonPath = join(subgraphRoot, "deployments", "arbitrum-one.json");
    writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`, "utf8");
    console.log(`Wrote ${deployJsonPath}`);

    if (!envBool("SKIP_SUBGRAPH_SYNC", true)) {
        spawnSync("yarn", ["update:subgraph:abis"], { cwd: contractsRoot, stdio: "inherit", shell: true });
        spawnSync("yarn", ["sync:pipeline"], {
            cwd: subgraphRoot,
            stdio: "inherit",
            shell: true,
            env: { ...process.env, DEPLOY_JSON: "./deployments/arbitrum-one.json" },
        });
    }

    const runVerify = envBool("VERIFY_CONTRACTS", vars.has("ETHERSCAN_API_KEY"));
    if (runVerify && vars.has("ETHERSCAN_API_KEY")) {
        const verifyDelayMs = Number(envBigIntOr("VERIFY_DELAY_MS", 12_000n));
        if (uniswapDeployed) {
            await verifyContractWithDelay(uniswapDeployed.factory, [protocolAdmin], verifyDelayMs, FQ_UNISWAP_FACTORY);
            await verifyContractWithDelay(uniswapDeployed.weth, [], verifyDelayMs, FQ_WETH9);
            await verifyContractWithDelay(
                uniswapDeployed.router,
                [uniswapDeployed.factory, uniswapDeployed.weth],
                verifyDelayMs,
                FQ_UNISWAP_ROUTER,
            );
        }
        await verifyContractWithDelay(jackpotTreasury.address, [brb, engine.address, protocolAdmin], verifyDelayMs);
        await verifyContractWithDelay(
            funder.address,
            [engine.address, brb, router, jackpotTreasury.address, sideBet.address, protocolAdmin],
            verifyDelayMs,
        );
        await verifyContractWithDelay(registry.address, [protocolAdmin, engine.address, sideBet.address], verifyDelayMs);
        await verifyContractWithDelay(vaultImpl.address, [], verifyDelayMs);
        await verifyContractWithDelay(beacon.address, [vaultImpl.address, protocolAdmin], verifyDelayMs);
        if (brbReferral !== zeroAddress) {
            await verifyContractWithDelay(brbReferral, [engine.address], verifyDelayMs);
        }
        await verifyRouletteLinkedLibraries(linkedLibraries, verifyDelayMs);

        const [usdcVaultInit, daiVaultInit, brbVaultInit] = await Promise.all([
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: usdc,
                marketId: 1,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minStable,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: dai,
                marketId: 2,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minDai,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: brb,
                marketId: 3,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minBrb,
                sideBetController: sideBet.address,
            }),
        ]);

        await verifyProtocolProxies({
            delayMs: verifyDelayMs,
            engineProxy: engine.address,
            engineImplementation: engineImplementation.address,
            engineInitData: engineProxyInitData,
            engineImplCtorArgs: [
                vrfCoordinator,
                vrfKeyHashes[0],
                vrfKeyHashes[1],
                vrfKeyHashes[2],
                confirmations,
                brbReferral,
            ],
            engineLibraryMap: buildRouletteEngineLibraryMap(linkedLibraries),
            sideBetProxy: sideBet.address,
            sideBetImplementation: sideBetImplementation.address,
            sideBetInitData: sideBetProxyInitData,
            vaultBeacon: beacon.address,
            bankVaults: [
                { bank: marketUsdc.bank, initData: usdcVaultInit },
                { bank: marketDai.bank, initData: daiVaultInit },
                { bank: marketBrb.bank, initData: brbVaultInit },
            ],
        });

        await verifyContractWithDelay(
            scheduler.address,
            [
                engine.address,
                sideBet.address,
                protocolAdmin,
                Number(envBigIntOr("UPKEEP_SCAN_LIMIT", 25n)),
                Number(envBigIntOr("UPKEEP_MAX_PAYOUTS_PER_CALL", 60n)),
            ],
            verifyDelayMs,
        );
    }

    console.log(JSON.stringify(deploymentManifest, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
