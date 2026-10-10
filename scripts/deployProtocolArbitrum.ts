import "dotenv/config";

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { parseUnits, zeroAddress } from "viem";

import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import {
    CRE_KEYSTONE_FORWARDER_ARBITRUM_ONE,
    deployCreAutomation,
} from "./utils/deployCreAutomation";
import { resolveCreLaneCounts, writeCreWorkflowConfigs } from "./utils/writeCreWorkflowConfigs";
import { boundedInteger, requiredAddress, MAINNET_CONFIRMATION, preflightMainnet, handoffProtocolRoles } from "./utils/mainnetRelease";
import {
    envAddressOrDefault,
    envBigIntOr,
    envBool,
    optionalAddressEnv,
    vrfKeyHashTriple,
} from "./utils/protocolDeployEnv";
import { vrfAddConsumerIfNeeded, vrfFundSubscriptionWithLink } from "./utils/vrfSubscription";
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
 * Read-only preflight by default; broadcast requires CONFIRM_MAINNET_DEPLOY=arbitrum-one:42161.
 * Production-oriented deploy for Arbitrum One (chain 42161).
 *
 * Run: `yarn deploy:protocol:arbitrum`
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` and `hardhat vars set ARBITRUM_RPC_URL`
 * - `UNISWAP_V2_ROUTER` — reviewed production Uniswap V2 compatible router (required)
 * - `USDC_TOKEN`, `DAI_TOKEN`, optional `BRB_TOKEN` (omit to deploy new BRBToken to `PROTOCOL_ADMIN`)
 * - `PROTOCOL_ADMIN` — explicit admin wallet (EOA initially; migrate to Safe later)
 * - Funded VRF subscription (`VRF_SUBSCRIPTION_ID`)
 * - After deploy: register CRE workflows per lane (see docs/CRE_MIGRATION.md)
 * - Verify Chainlink addresses on https://docs.chain.link before mainnet deploy
 *
 * Defaults (override via env): see Chainlink VRF v2.5 + Automation docs for Arbitrum One.
 */


const DEFAULT_LINK = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" as const;
/** VRF v2.5 coordinator — must match `VRFConsumerBaseV2` / subscription interface. */
const DEFAULT_VRF_COORDINATOR = "0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e" as const;
const DEFAULT_VRF_KEY_HASH_2_GWEI =
    "0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897" as const;
const DEFAULT_VRF_KEY_HASH_30_GWEI =
    "0x8472ba59cf7134dfe321f4d61a430c4857e8b19cdd5230b09952a92671c24409" as const;
const DEFAULT_VRF_KEY_HASH_150_GWEI =
    "0xe9f223d7d83ec85c4f78042a4845af3a1c8df7757b4997b815ce4b8d07aca68c" as const;

/** CRE KeystoneForwarder on Arbitrum One — override with CRE_KEYSTONE_FORWARDER; verify in Chainlink Forwarder Directory. */
const DEFAULT_CRE_KEYSTONE_FORWARDER = CRE_KEYSTONE_FORWARDER_ARBITRUM_ONE;

const DEFAULT_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const DEFAULT_DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as const;


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

    const protocolAdmin = requiredAddress("PROTOCOL_ADMIN");
    const bootstrapAdmin = deployer.account.address;
    const workflowOwner = requiredAddress("CRE_WORKFLOW_OWNER");
    const infraRecipient =
        optionalAddressEnv("INFRA_RECIPIENT", process.env.INFRA_RECIPIENT) ?? protocolAdmin;

    if (envBool("DEPLOY_LOCAL_UNISWAP", false)) throw new Error("Local Uniswap is forbidden on mainnet");
    if (!envBool("SKIP_SUBGRAPH_SYNC", true)) throw new Error("Build/release the subgraph separately; deployment never mutates testnet or Goldsky");
    const router = requiredAddress("UNISWAP_V2_ROUTER");
    const vrfCoordinator = envAddressOrDefault("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);
    const linkToken = envAddressOrDefault("LINK_TOKEN", DEFAULT_LINK);
    const creKeystoneForwarder = envAddressOrDefault("CRE_KEYSTONE_FORWARDER", DEFAULT_CRE_KEYSTONE_FORWARDER);
    const usdc = envAddressOrDefault("USDC_TOKEN", DEFAULT_USDC);
    const dai = envAddressOrDefault("DAI_TOKEN", DEFAULT_DAI);

    const vrfSubFromEnv = boundedInteger("VRF_SUBSCRIPTION_ID", 0n, 1n, 2n ** 256n - 1n);
    if (vrfSubFromEnv === 0n) {
        throw new Error("VRF_SUBSCRIPTION_ID is required on Arbitrum One (create at vrf.chain.link).");
    }
    const vrfSubscriptionId = vrfSubFromEnv;

    const vrfInitialLinkJuels = boundedInteger("VRF_INITIAL_LINK_JUELS", 0n, 0n, 2n ** 96n - 1n);
    const vrfKeyHashes = vrfKeyHashTriple([DEFAULT_VRF_KEY_HASH_2_GWEI, DEFAULT_VRF_KEY_HASH_30_GWEI, DEFAULT_VRF_KEY_HASH_150_GWEI]);
    if (vrfKeyHashes.some(hash => BigInt(hash) === 0n)) throw new Error("VRF gas lane key hashes cannot be zero");
    const callbackGasLimit = Number(boundedInteger("VRF_CALLBACK_GAS_LIMIT", 2_500_000n, 1n, 2_500_000n));
    const confirmations = Number(boundedInteger("VRF_CONFIRMATIONS", 3n, 1n, 200n));
    const roundDuration = Number(boundedInteger("ROUND_DURATION_SECONDS", 300n, 1n, 2n ** 32n - 1n));
    const { payoutLaneCount, creWorkflowLaneCount } = resolveCreLaneCounts({
        payoutLaneCount: process.env.PAYOUT_LANE_COUNT,
        upkeepLaneCount: process.env.UPKEEP_LANE_COUNT,
    });
    const creLaneMaxDrainIterations = Number(boundedInteger("CRE_LANE_MAX_DRAIN_ITERATIONS", 5n, 1n, 100n));

    boundedInteger("VERIFY_DELAY_MS", 12_000n, 0n, 60_000n);
    boundedInteger("PAYOUT_LANE_COUNT", 10n, 1n, 100n);
    boundedInteger("UPKEEP_LANE_COUNT", BigInt(payoutLaneCount), 1n, 100n);
    const brbAddressEnv = optionalAddressEnv("BRB_TOKEN", process.env.BRB_TOKEN);
    const minStable = parseUnits(process.env.MIN_BET_STABLE ?? "1", 6);
    const minDai = parseUnits(process.env.MIN_BET_DAI ?? "1", 18);
    const minBrb = parseUnits(process.env.MIN_BET_BRB ?? "1", 18);
    if ([minStable, minDai, minBrb].some(value => value <= 0n || value > 2n ** 128n - 1n)) throw new Error("Invalid market minimum bet");
    const scanLimit = Number(boundedInteger("UPKEEP_SCAN_LIMIT", 25n, 1n, 2n ** 32n - 1n));
    const maxPayouts = Number(boundedInteger("UPKEEP_MAX_PAYOUTS_PER_CALL", 60n, 1n, 2n ** 32n - 1n));
    if (payoutLaneCount !== creWorkflowLaneCount) throw new Error("Mainnet requires a deployed CRE workflow for every payout lane");
    const brbStartBlock = brbAddressEnv ? Number(boundedInteger("BRB_START_BLOCK", 0n, 1n, BigInt(Number.MAX_SAFE_INTEGER))) : undefined;
    const workflowHttpKey = optionalAddressEnv("CRE_HTTP_AUTHORIZED_ADDRESS", process.env.CRE_HTTP_AUTHORIZED_ADDRESS);
    if (!workflowHttpKey || workflowHttpKey === zeroAddress) throw new Error("CRE_HTTP_AUTHORIZED_ADDRESS is required on mainnet");
    const preflight = await preflightMainnet(publicClient, { deployer: bootstrapAdmin, admin: protocolAdmin,
        router, coordinator: vrfCoordinator, link: linkToken, forwarder: creKeystoneForwarder,
        usdc, dai, subscriptionId: vrfSubscriptionId, brb: brbAddressEnv });
    if (brbStartBlock && brbStartBlock > Number(preflight.blockNumber)) throw new Error("BRB_START_BLOCK is in the future");
    console.log(JSON.stringify({ ...preflight, workflowOwner, activationApproved: false }, null, 2));
    if (process.env.CONFIRM_MAINNET_DEPLOY !== MAINNET_CONFIRMATION) {
        console.log("Read-only preflight complete. Review docs/MAINNET_RUNBOOK.md before setting CONFIRM_MAINNET_DEPLOY.");
        return;
    }
    const contractsRoot = join(__dirname, "..");
    const releaseDir = join(contractsRoot, "deployments");
    mkdirSync(releaseDir, { recursive: true });
    const deployJsonPath = join(releaseDir, "arbitrum-one.json");
    const journalPath = join(releaseDir, "arbitrum-one-progress.json");
    if (existsSync(deployJsonPath) || existsSync(journalPath)) throw new Error("Mainnet release already started; inspect its journal and chain receipts before any recovery. Do not rerun blindly.");
    const deployBlock = Number(preflight.blockNumber);
    const deploymentNonce = await publicClient.getTransactionCount({ address: bootstrapAdmin, blockTag: "pending" });
    writeFileSync(journalPath, JSON.stringify({ stage: "started", deployer: bootstrapAdmin, deploymentNonce, preflight }, null, 2) + "\n", { flag: "wx" });
    if (vrfInitialLinkJuels > 0n) await vrfFundSubscriptionWithLink(deployer, publicClient, linkToken, vrfCoordinator, vrfSubscriptionId, vrfInitialLinkJuels);
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
                bootstrapAdmin,
            ],
            {
                admin: bootstrapAdmin,
                scanLimit,
                maxPayoutsPerCall: maxPayouts,
            },
            {
                protocolPrefix: { brb, mockRouter: router, admin: bootstrapAdmin },
                deployBrbReferral: true,
                wireMockForwarder: false,
            },
        );

    writeFileSync(journalPath, JSON.stringify({ stage: "stack-deployed", deployer: bootstrapAdmin, deploymentNonce,
        brb, engine: engine.address, engineImplementation: engineImplementation.address, registry: registry.address,
        sideBet: sideBet.address, sideBetImplementation: sideBetImplementation.address, scheduler: scheduler.address,
        jackpotTreasury: jackpotTreasury.address, jackpotFunder: funder.address, brbReferral, linkedLibraries }, null, 2) + "\n");
    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, protocolAdmin]);
    await waitWrite(registry.write.setVaultBeacon([beacon.address], { account: deployer.account }));

    await vrfAddConsumerIfNeeded(deployer, publicClient, vrfCoordinator, vrfSubscriptionId, engine.address);

    await waitWrite(engine.write.setPayoutLaneCount([payoutLaneCount], { account: deployer.account }));
    console.log(`Payout parallel lanes: ${payoutLaneCount} on-chain, ${creWorkflowLaneCount} CRE workflow(s)`);

    const creAutomation = await deployCreAutomation({
        scheduler: scheduler.address,
        admin: bootstrapAdmin,
        expectedWorkflowOwner: workflowOwner,
        receiverOwner: protocolAdmin,
        keystoneForwarder: creKeystoneForwarder,
        wallet: deployer,
        publicClient,
        waitWrite,
    });

    const creProject = join(releaseDir, "arbitrum-one-cre");
    const creOutput = join(creProject, "workflows/biribi-roulette-lane");
    mkdirSync(creOutput, { recursive: true });
    cpSync(join(contractsRoot, "cre/contracts"), join(creProject, "contracts"), { recursive: true });
    cpSync(join(contractsRoot, "cre/package.json"), join(creProject, "package.json"));
    for (const file of ["main.ts", "package.json", "tsconfig.json"]) {
        cpSync(join(contractsRoot, "cre/workflows/biribi-roulette-lane", file), join(creOutput, file));
    }
    writeCreWorkflowConfigs({
        outputDirectory: creOutput,
        network: "arbitrum-one",
        scheduler: scheduler.address,
        receiver: creAutomation.automationReceiver,
        engine: engine.address,
        laneCount: creWorkflowLaneCount,
        writeGasLimit: process.env.CRE_WRITE_GAS_LIMIT?.trim() ?? "2500000",
        laneMaxDrainIterations: creLaneMaxDrainIterations,
        httpAuthorizedKeys: (() => {
            const key = optionalAddressEnv(
                "CRE_HTTP_AUTHORIZED_ADDRESS",
                process.env.CRE_HTTP_AUTHORIZED_ADDRESS,
            );
            return key ? [key] : undefined;
        })(),
    });

    const creTargets = ["test-settings", "production-settings", "trigger-vrf-test-settings", "trigger-vrf-production-settings",
        ...Array.from({ length: creWorkflowLaneCount }, (_, lane) => [`lane${lane}-test-settings`, `lane${lane}-production-settings`]).flat()];
    writeFileSync(join(creProject, "project.yaml"), creTargets.map(target =>
        `${target}:\n  rpcs:\n    - chain-name: ethereum-mainnet-arbitrum-1\n      url: \${ARBITRUM_RPC_URL}\n`).join("\n"));

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
    const challengeEvaluator = await sideBet.read.CHALLENGE_EVALUATOR();

    const deploymentManifest = {
        network: "arbitrum-one",
        chainId: 42161,
        startBlock: deployBlock,
        startBlocks: { brb: brbStartBlock ?? deployBlock },
        deployer: bootstrapAdmin,
        workflowOwner,
        activationApproved: false,
        handoffComplete: false,
        verificationComplete: false,
        linkedLibraries,
        protocolAdmin,
        infraRecipient,
        addresses: {
            brb,
            brbReferal: brbReferral,
            registry: registry.address,
            roulette: engine.address,
            engine: engine.address,
            engineImplementation: engineImplementation.address,
            sideBet: sideBet.address,
            sideBetImplementation: sideBetImplementation.address,
            challengeEvaluator,
            scheduler: scheduler.address,
            automationReceiver: creAutomation.automationReceiver,
            creExecutionAuthority: creAutomation.creExecutionAuthority,
            creKeystoneForwarder: creAutomation.keystoneForwarder,
            creWorkflowLaneCount,
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
            linkToken,
            subscriptionId: vrfSubscriptionId.toString(),
            keyHash2Gwei: vrfKeyHashes[0],
            keyHash30Gwei: vrfKeyHashes[1],
            keyHash150Gwei: vrfKeyHashes[2],
        },
    };

    writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`, { flag: "wx" });
    const authority = await viem.getContractAt("CreExecutionAuthority", creAutomation.creExecutionAuthority);
    await handoffProtocolRoles([
        { contract: engine, roles: ["DEFAULT_ADMIN_ROLE", "ENGINE_WITHDRAWAL_ROLE", "ENGINE_PAYOUT_ROLE", "ENGINE_ROUND_ROLE", "ENGINE_FEE_ROLE"] },
        { contract: sideBet, roles: ["DEFAULT_ADMIN_ROLE", "SIDE_BET_CONFIG_ROLE", "SIDE_BET_LIMITS_ROLE"] },
        { contract: registry, roles: ["DEFAULT_ADMIN_ROLE", "MARKET_FACTORY_ROLE"] },
        { contract: scheduler, roles: ["DEFAULT_ADMIN_ROLE", "SCHEDULER_ADMIN_ROLE"] },
        { contract: funder, roles: ["DEFAULT_ADMIN_ROLE", "FUNDER_ADMIN_ROLE"] },
        { contract: jackpotTreasury, roles: ["DEFAULT_ADMIN_ROLE", "TREASURY_ADMIN_ROLE"] },
        { contract: authority, roles: ["DEFAULT_ADMIN_ROLE", "EXECUTOR_ADMIN_ROLE"] },
    ], bootstrapAdmin, protocolAdmin, waitWrite);
    deploymentManifest.handoffComplete = true;
    writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`);
    writeFileSync(journalPath, JSON.stringify({ stage: "configured-handoff-complete", manifest: deployJsonPath }, null, 2) + "\n");

    const runVerify = envBool("VERIFY_CONTRACTS", true);
    if (runVerify && vars.has("ETHERSCAN_API_KEY")) {
        const verifyDelayMs = Number(envBigIntOr("VERIFY_DELAY_MS", 12_000n));
        if (!brbAddressEnv) await verifyContractWithDelay(brb, [protocolAdmin], verifyDelayMs);
        await verifyContractWithDelay(jackpotTreasury.address, [brb, engine.address, bootstrapAdmin], verifyDelayMs);
        await verifyContractWithDelay(
            funder.address,
            [engine.address, brb, router, jackpotTreasury.address, sideBet.address, bootstrapAdmin],
            verifyDelayMs,
        );
        await verifyContractWithDelay(registry.address, [bootstrapAdmin, engine.address, sideBet.address], verifyDelayMs);
        await verifyContractWithDelay(challengeEvaluator, [], verifyDelayMs);
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
            strict: true,
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
                bootstrapAdmin,
                scanLimit,
                maxPayouts,
            ],
            verifyDelayMs,
        );
        await verifyContractWithDelay(
            creAutomation.automationReceiver,
            [creKeystoneForwarder],
            verifyDelayMs,
            "contracts/chainlink/cre/AutomationReceiver.sol:AutomationReceiver",
        );
        await verifyContractWithDelay(creAutomation.creExecutionAuthority, [bootstrapAdmin], verifyDelayMs);
        deploymentManifest.verificationComplete = true;
        writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`);
    }

    console.log(JSON.stringify(deploymentManifest, null, 2));
    console.log("Contracts configured. Public launch, liquidity, CRE activation, index promotion and Vercel cutover remain separate runbook gates.");
}

main().catch((error) => {
    // Viem errors can embed RPC URLs/headers. Never print raw transport errors.
    const message = error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message)
        ? error.message : "Mainnet operation failed or its result is uncertain. Inspect the local deployment journal and chain receipts before recovery; do not rerun blindly.";
    console.error(message);
    process.exitCode = 1;
});
