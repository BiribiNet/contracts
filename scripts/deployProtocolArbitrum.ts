import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network, viem } from "hardhat";

import {
    ARBITRUM_RPC_URLS,
    BRB_INFRA_AMOUNT,
    BRB_LIQUIDITY_AMOUNT,
    BRB_MARKETING_AMOUNT,
    CLOUDFLARE_WORKER_NAME,
    DAI,
    KEEPER_MAX_DRAIN_ITERATIONS,
    LINK_TOKEN,
    MIN_BET_BRB,
    MIN_BET_DAI,
    MIN_BET_USDC,
    PAYOUT_LANE_COUNT,
    ROUND_DURATION_SECONDS,
    UNISWAP_V2_FACTORY,
    UNISWAP_V2_ROUTER,
    UPKEEP_MAX_PAYOUTS_PER_CALL,
    UPKEEP_SCAN_LIMIT,
    USDC,
    VRF_CALLBACK_GAS_LIMIT,
    VRF_CONFIRMATIONS,
    VRF_COORDINATOR,
    VRF_KEY_HASH_2_GWEI,
    VRF_KEY_HASH_30_GWEI,
    VRF_KEY_HASH_150_GWEI,
    assertGenesisWalletsConfigured,
} from "./constants/arbitrumOne";
import { deployKeeperAutomation } from "./utils/deployKeeperAutomation";
import { deployProductionRouletteEngine } from "./utils/deployRouletteEngine";
import {
    createArbitrumFallbackPublicClient,
    installHardhatRpcFailover,
} from "./utils/hardhatRpcFailover";
import {
    assertProtocolRoleHandoff,
    handoffProtocolRoles,
    preflightMainnet,
} from "./utils/mainnetRelease";
import { seedBrbAssetPool } from "./utils/seedUniswapV2BrbPools";
import {
    vrfAddConsumerIfNeeded,
    vrfCreateSubscription,
    vrfFundSubscriptionWithAllLink,
} from "./utils/vrfSubscription";
/**
 * Arbitrum One (42161) protocol deploy — addresses fixed in `scripts/constants/arbitrumOne.ts`.
 * Automation is Cloudflare Workers keeper mode (no Chainlink CRE).
 *
 * Only BRB_KEY supplies the signing account. All public settings are in the address catalog.
 * Provision the Worker with `yarn deploy:cloudflare:arbitrum` after deploying contracts.
 *
 * RPC: Hardhat bootstraps on the first `ARBITRUM_RPC_URLS` entry; mid-script failures
 * retry on the remaining public endpoints (provider wrap + receipt client).
 *
 * Run: `yarn deploy:protocol:arbitrum`
 */

async function main() {
    const { marketingWallet, infraWallet, keeperWallet } = assertGenesisWalletsConfigured();

    installHardhatRpcFailover(network.provider);
    console.log(`RPC failover armed (${ARBITRUM_RPC_URLS.length} endpoints)`);

    const publicClient = await viem.getPublicClient();
    const receiptClient = createArbitrumFallbackPublicClient();
    const walletClients = await viem.getWalletClients();
    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== 42161n) {
        throw new Error(`This script targets Arbitrum One (42161). Current chainId: ${chainId}`);
    }

    const waitWrite = async (hashPromise: Promise<`0x${string}`>) => {
        const hash = await hashPromise;
        appendFileSync(transactionJournalPath, JSON.stringify({ event: "broadcast", hash }) + "\n");
        const receipt = await receiptClient.waitForTransactionReceipt({ hash });
        appendFileSync(
            transactionJournalPath,
            JSON.stringify({
                event: "receipt",
                hash,
                status: receipt.status,
                blockNumber: receipt.blockNumber.toString(),
            }) + "\n",
        );
        if (receipt.status !== "success") {
            throw new Error(`Transaction reverted (hash ${hash})`);
        }
    };

    const [deployer] = walletClients;
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const bootstrapAdmin = deployer.account.address;
    const protocolAdmin = bootstrapAdmin;
    const infraRecipient = infraWallet;
    const router = UNISWAP_V2_ROUTER;
    const vrfCoordinator = VRF_COORDINATOR;
    const linkToken = LINK_TOKEN;
    const usdc = USDC;
    const dai = DAI;
    const vrfKeyHashes = [VRF_KEY_HASH_2_GWEI, VRF_KEY_HASH_30_GWEI, VRF_KEY_HASH_150_GWEI] as const;
    const callbackGasLimit = VRF_CALLBACK_GAS_LIMIT;
    const confirmations = VRF_CONFIRMATIONS;
    const roundDuration = ROUND_DURATION_SECONDS;
    const payoutLaneCount = PAYOUT_LANE_COUNT;
    const scanLimit = UPKEEP_SCAN_LIMIT;
    const maxPayouts = UPKEEP_MAX_PAYOUTS_PER_CALL;
    const minStable = MIN_BET_USDC;
    const minDai = MIN_BET_DAI;
    const minBrb = MIN_BET_BRB;

    const preflight = await preflightMainnet(publicClient, {
        deployer: bootstrapAdmin,
        admin: protocolAdmin,
        router,
        coordinator: vrfCoordinator,
        link: linkToken,
        usdc,
        dai,
        expectedFactory: UNISWAP_V2_FACTORY,
        keeper: keeperWallet,
        callbackGasLimit, confirmations, vrfKeyHashes,
    });
    console.log(
        JSON.stringify(
            {
                ...preflight,
                automation: "cloudflare-keeper",
                keeperWallet,
                cloudflareWorkerName: CLOUDFLARE_WORKER_NAME,
                marketingWallet,
                infraWallet,
                brbGenesis: {
                    liquidityBrb: BRB_LIQUIDITY_AMOUNT.toString(),
                    marketingBrb: BRB_MARKETING_AMOUNT.toString(),
                    infraBrb: BRB_INFRA_AMOUNT.toString(),
                    usdcSeed: "entire deployer USDC balance",
                },
            },
            null,
            2,
        ),
    );

    const contractsRoot = join(__dirname, "..");
    const releaseDir = join(contractsRoot, "deployments");
    mkdirSync(releaseDir, { recursive: true });
    const deployJsonPath = join(releaseDir, "arbitrum-one.json");
    const journalPath = join(releaseDir, "arbitrum-one-progress.json");
    const transactionJournalPath = join(releaseDir, "arbitrum-one-transactions.jsonl");
    if (existsSync(deployJsonPath) || existsSync(journalPath)) {
        throw new Error(
            "Mainnet release already started; inspect its journal and chain receipts before any recovery. Do not rerun blindly.",
        );
    }
    const deployBlock = Number(preflight.blockNumber);
    const deploymentNonce = await publicClient.getTransactionCount({
        address: bootstrapAdmin,
        blockTag: "pending",
    });
    writeFileSync(
        journalPath,
        JSON.stringify({ stage: "started", deployer: bootstrapAdmin, deploymentNonce, preflight }, null, 2) + "\n",
        { flag: "wx" },
    );

    const vrfSubscriptionId = await vrfCreateSubscription(deployer, publicClient, vrfCoordinator);
    console.log(`Created VRF subscription id: ${vrfSubscriptionId.toString()}`);
    const linkFundedJuels = await vrfFundSubscriptionWithAllLink(
        deployer,
        publicClient,
        linkToken,
        vrfCoordinator,
        vrfSubscriptionId,
    );
    console.log(
        `Drained ${linkFundedJuels.toString()} Juels LINK from deployer into VRF subscription ${vrfSubscriptionId.toString()}`,
    );

    const brbC = await viem.deployContract("BRBToken", [bootstrapAdmin]);
    const brb = brbC.address;
    console.log(`Deployed BRBToken to ${brb} (minted to deployer for genesis distribution)`);

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
    } = await deployProductionRouletteEngine({
        brb, router, admin: bootstrapAdmin, infraRecipient,
        coordinator: vrfCoordinator, subscriptionId: vrfSubscriptionId,
        callbackGasLimit, confirmations, roundDuration, vrfKeyHashes,
        scheduler: { admin: bootstrapAdmin, scanLimit, maxPayoutsPerCall: maxPayouts },
    });

    writeFileSync(
        journalPath,
        JSON.stringify(
            {
                stage: "stack-deployed",
                deployer: bootstrapAdmin,
                deploymentNonce,
                brb,
                engine: engine.address,
                engineImplementation: engineImplementation.address,
                registry: registry.address,
                sideBet: sideBet.address,
                sideBetImplementation: sideBetImplementation.address,
                scheduler: scheduler.address,
                jackpotTreasury: jackpotTreasury.address,
                jackpotFunder: funder.address,
                brbReferral,
                linkedLibraries,
                vrfSubscriptionId: vrfSubscriptionId.toString(),
            },
            null,
            2,
        ) + "\n",
    );
    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, protocolAdmin]);
    await waitWrite(registry.write.setVaultBeacon([beacon.address], { account: deployer.account }));

    await vrfAddConsumerIfNeeded(deployer, publicClient, vrfCoordinator, vrfSubscriptionId, engine.address);

    await waitWrite(engine.write.setPayoutLaneCount([payoutLaneCount], { account: deployer.account }));
    console.log(
        `Payout parallel lanes: ${payoutLaneCount} on-chain (Cloudflare keeper drain, max ${KEEPER_MAX_DRAIN_ITERATIONS} iterations/wake)`,
    );

    const keeperAutomation = await deployKeeperAutomation({
        scheduler: scheduler.address,
        admin: bootstrapAdmin,
        keeper: keeperWallet,
        wallet: deployer,
        publicClient,
        waitWrite,
    });
    console.log(
        `Keeper automation: CreExecutionAuthority ${keeperAutomation.creExecutionAuthority}, keeper ${keeperWallet}`,
    );

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

    const tipJar = await viem.deployContract("TipJar", [brb, engine.address]);
    console.log(`Deployed TipJar at ${tipJar.address}`);

    const erc20Abi = [
        {
            type: "function",
            name: "balanceOf",
            stateMutability: "view",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ type: "uint256" }],
        },
        {
            type: "function",
            name: "transfer",
            stateMutability: "nonpayable",
            inputs: [
                { name: "to", type: "address" },
                { name: "amount", type: "uint256" },
            ],
            outputs: [{ type: "bool" }],
        },
    ] as const;

    const brbBal = await publicClient.readContract({
        address: brb,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [bootstrapAdmin],
    });
    if (brbBal !== BRB_LIQUIDITY_AMOUNT + BRB_MARKETING_AMOUNT + BRB_INFRA_AMOUNT) {
        throw new Error(
            `Unexpected deployer BRB balance ${brbBal.toString()} — expected full 3_000_000 supply before genesis split`,
        );
    }
    await waitWrite(
        deployer.writeContract({
            address: brb,
            abi: erc20Abi,
            functionName: "transfer",
            args: [marketingWallet, BRB_MARKETING_AMOUNT],
            account: deployer.account,
            chain: publicClient.chain,
        }),
    );
    await waitWrite(
        deployer.writeContract({
            address: brb,
            abi: erc20Abi,
            functionName: "transfer",
            args: [infraWallet, BRB_INFRA_AMOUNT],
            account: deployer.account,
            chain: publicClient.chain,
        }),
    );
    console.log(
        `Allocated ${BRB_MARKETING_AMOUNT.toString()} BRB to marketing ${marketingWallet} and ${BRB_INFRA_AMOUNT.toString()} BRB to infra ${infraWallet}`,
    );

    const usdcLiquidity = await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [bootstrapAdmin],
    });
    if (usdcLiquidity === 0n) {
        throw new Error("Deployer USDC balance is 0 — fund the deploy wallet before seeding the USDC/BRB pair");
    }

    console.log(
        `Seeding Uniswap V2 USDC/BRB with full deployer USDC (${usdcLiquidity.toString()}) + ${BRB_LIQUIDITY_AMOUNT.toString()} BRB; LP to deployer (LPVestingLock deferred)`,
    );
    const seeded = await seedBrbAssetPool(
        deployer,
        publicClient,
        {
            router,
            brb,
            asset: usdc,
            assetAmount: usdcLiquidity,
            brbAmount: BRB_LIQUIDITY_AMOUNT,
            assetLabel: "USDC",
        },
        waitWrite,
    );

    await waitWrite(funder.write.updateObservation([usdc], { account: deployer.account }));

    const deploymentManifest = {
        network: "arbitrum-one",
        chainId: 42161,
        startBlock: deployBlock,
        startBlocks: { brb: deployBlock },
        deployer: bootstrapAdmin,
        activationApproved: false,
        handoffComplete: false,
        verificationComplete: false,
        linkedLibraries,
        proxyInitialization: { engine: engineProxyInitData, sideBet: sideBetProxyInitData },
        protocolAdmin,
        infraRecipient,
        marketingWallet,
        infraWallet,
        automation: {
            mode: "cloudflare-keeper" as const,
            keeper: keeperWallet,
            cloudflareWorkerName: CLOUDFLARE_WORKER_NAME,
            payoutLaneCount,
            keeperMaxDrainIterations: KEEPER_MAX_DRAIN_ITERATIONS,
            note: "Provision the keeper with yarn deploy:cloudflare:arbitrum using Wrangler login",
        },
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
            creExecutionAuthority: keeperAutomation.creExecutionAuthority,
            jackpotTreasury: jackpotTreasury.address,
            jackpotFunder: funder.address,
            tipJar: tipJar.address,
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
        liquidity: {
            usdcBrb: {
                pair: seeded.pair,
                liquidity: seeded.liquidity.toString(),
                lpHolder: seeded.lpRecipient,
                usdcAmount: usdcLiquidity.toString(),
                brbAmount: BRB_LIQUIDITY_AMOUNT.toString(),
            },
            brbAllocation: {
                marketing: { wallet: marketingWallet, amount: BRB_MARKETING_AMOUNT.toString() },
                infra: { wallet: infraWallet, amount: BRB_INFRA_AMOUNT.toString() },
            },
            lpVestingLockDeferred: true,
            note: "USDC/BRB LP is held by lpHolder; deploy LPVestingLock later and transfer LP when ready",
        },
        vrf: {
            coordinator: vrfCoordinator,
            linkToken,
            subscriptionId: vrfSubscriptionId.toString(),
            keyHash2Gwei: vrfKeyHashes[0],
            keyHash30Gwei: vrfKeyHashes[1],
            keyHash150Gwei: vrfKeyHashes[2],
            linkFundedFromDeployerJuels: linkFundedJuels.toString(),
        },
    };

    writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`, { flag: "wx" });
    const authority = await viem.getContractAt(
        "CreExecutionAuthority",
        keeperAutomation.creExecutionAuthority,
    );
    const roleHandoff = [
        {
            contract: engine,
            roles: ["DEFAULT_ADMIN_ROLE", "ENGINE_WITHDRAWAL_ROLE", "ENGINE_PAYOUT_ROLE", "ENGINE_ROUND_ROLE", "ENGINE_FEE_ROLE"],
            label: "RouletteEngine",
        },
        {
            contract: sideBet,
            roles: ["DEFAULT_ADMIN_ROLE", "SIDE_BET_CONFIG_ROLE", "SIDE_BET_LIMITS_ROLE"],
            label: "SideBet",
        },
        { contract: registry, roles: ["DEFAULT_ADMIN_ROLE", "MARKET_FACTORY_ROLE"], label: "MarketRegistry" },
        { contract: scheduler, roles: ["DEFAULT_ADMIN_ROLE", "SCHEDULER_ADMIN_ROLE"], label: "UpkeepScheduler" },
        { contract: funder, roles: ["DEFAULT_ADMIN_ROLE", "FUNDER_ADMIN_ROLE"], label: "BRBJackpotFunder" },
        { contract: jackpotTreasury, roles: ["DEFAULT_ADMIN_ROLE", "TREASURY_ADMIN_ROLE"], label: "JackpotTreasury" },
        { contract: authority, roles: ["DEFAULT_ADMIN_ROLE", "EXECUTOR_ADMIN_ROLE"], label: "CreExecutionAuthority" },
    ];
    await handoffProtocolRoles(roleHandoff, bootstrapAdmin, protocolAdmin, waitWrite);
    await assertProtocolRoleHandoff(roleHandoff, bootstrapAdmin, protocolAdmin);
    if (!(await sideBet.read.hasRole([await sideBet.read.SETTLEMENT_ROLE(), scheduler.address]))) {
        throw new Error("SideBet SETTLEMENT_ROLE missing on scheduler after handoff");
    }
    if (!(await authority.read.isApprovedAutomationForwarder([keeperWallet]))) {
        throw new Error("Keeper lost CreExecutionAuthority approval after handoff");
    }
    deploymentManifest.handoffComplete = true;
    writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`);
    writeFileSync(
        journalPath,
        JSON.stringify({ stage: "configured-handoff-complete", manifest: deployJsonPath }, null, 2) + "\n",
    );


    console.log(JSON.stringify(deploymentManifest, null, 2));
    console.log(
        "Contracts configured (Cloudflare keeper automation). Next: yarn deploy:cloudflare:arbitrum after Wrangler login. LP remains on the deployer until LPVestingLock is deployed.",
    );
}

main().catch((error) => {
    const message =
        error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message)
            ? error.message
            : "Mainnet operation failed or its result is uncertain. Inspect the local deployment journal and chain receipts before recovery; do not rerun blindly.";
    console.error(message);
    process.exitCode = 1;
});
