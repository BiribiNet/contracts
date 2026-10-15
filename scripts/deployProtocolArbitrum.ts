import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network, viem } from "hardhat";
import { vars } from "hardhat/config";
import { createWalletClient, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
    ARBITRUM_RPC_URLS,
    HOUSE_BOT_BRB_AMOUNT, HOUSE_BOT_GAS_TARGET, MARKETING_GAS_TARGET, MARKETING_TRANSFER_GAS_BUFFER,
    BRB_INFRA_AMOUNT,
    BRB_INFRA_STAKE_AMOUNT,
    INFRA_GAS_TARGET,
    KEEPER_GAS_TARGET,
    MAINNET_DEPLOYMENT_MODE,
    BRB_LIQUIDITY_AMOUNT,
    BRB_MARKETING_AMOUNT,
    CLOUDFLARE_WORKER_NAME,
    DAI,
    KEEPER_MAX_DRAIN_ITERATIONS,
    LINK_TOKEN,
    MIN_BET_BRB,
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
import { createInfrastructureVrfSubscription, fundHouseBot, gasShortfall, stakeInfrastructureBrb, topUpGasWallets } from "./utils/mainnetBrbTest";
import { createRpcFallback } from "./utils/rpcFallback";
import {
    vrfAddConsumerIfNeeded,
} from "./utils/vrfSubscription";
/**
 * Arbitrum One (42161) protocol deploy — addresses fixed in `scripts/constants/arbitrumOne.ts`.
 * Automation is Cloudflare Workers keeper mode (no Chainlink CRE).
 *
 * Signing keys are loaded from Hardhat vars; all public addresses are fixed. All public settings are in the address catalog.
 * Provision the Worker with `yarn deploy:cloudflare:arbitrum` after deploying contracts.
 *
 * RPC: Hardhat bootstraps on the first `ARBITRUM_RPC_URLS` entry; mid-script failures
 * retry on the remaining public endpoints (provider wrap + receipt client).
 *
 * Run: `yarn deploy:protocol:arbitrum`
 */

async function main() {
    const { marketingWallet, infraWallet, keeperWallet, houseBotWallet } = assertGenesisWalletsConfigured();

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
    const minBrb = MIN_BET_BRB;

    if (!vars.has("KEEPER_PRIVATE_KEY") || !vars.has("INFRA_PRIVATE_KEY") || !vars.has("MARKETING_PRIVATE_KEY")) {
        throw new Error("Set KEEPER_PRIVATE_KEY, INFRA_PRIVATE_KEY and MARKETING_PRIVATE_KEY before deployment");
    }
    const keeperAccount = privateKeyToAccount(vars.get("KEEPER_PRIVATE_KEY") as Hex);
    const infraAccount = privateKeyToAccount(vars.get("INFRA_PRIVATE_KEY") as Hex);
    const marketingAccount = privateKeyToAccount(vars.get("MARKETING_PRIVATE_KEY") as Hex);
    if (keeperAccount.address.toLowerCase() !== keeperWallet.toLowerCase() ||
        infraAccount.address.toLowerCase() !== infraWallet.toLowerCase() ||
        marketingAccount.address.toLowerCase() !== marketingWallet.toLowerCase()) {
        throw new Error("Keeper, infrastructure or marketing signing key does not match its configured address");
    }
    if ([keeperWallet, infraWallet, marketingWallet, houseBotWallet].some(address => address.toLowerCase() === bootstrapAdmin.toLowerCase())) {
        throw new Error("Deployer must be separate from genesis recipients and the keeper");
    }
    const infrastructure = createWalletClient({ account: infraAccount, chain: publicClient.chain,
        transport: createRpcFallback([...ARBITRUM_RPC_URLS], 42161) });
    const marketing = createWalletClient({ account: marketingAccount, chain: publicClient.chain,
        transport: createRpcFallback([...ARBITRUM_RPC_URLS], 42161) });
    const marketingFundingTarget = MARKETING_GAS_TARGET + MARKETING_TRANSFER_GAS_BUFFER +
        gasShortfall(await receiptClient.getBalance({ address: houseBotWallet }), HOUSE_BOT_GAS_TARGET);
    for (const address of [infraWallet, marketingWallet, keeperWallet]) {
        const [latest, pending] = await Promise.all([
            receiptClient.getTransactionCount({ address, blockTag: "latest" }),
            receiptClient.getTransactionCount({ address, blockTag: "pending" }),
        ]);
        if (latest !== pending) throw new Error("A configured signing wallet has pending transactions; stop before deployment");
    }
    const tokenReadAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const usdcBefore = await receiptClient.readContract({ address: usdc, abi: tokenReadAbi, functionName: "balanceOf", args: [bootstrapAdmin] });
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
        deploymentMode: MAINNET_DEPLOYMENT_MODE,
        minimumLinkJuels: 1n,
        gasTopUps: { keeperTarget: KEEPER_GAS_TARGET, infra: infraWallet, infraTarget: INFRA_GAS_TARGET, marketing: marketingWallet, marketingTarget: marketingFundingTarget },
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
                houseBotWallet,
                brbGenesis: {
                    liquidityBrb: BRB_LIQUIDITY_AMOUNT.toString(),
                    marketingBrb: BRB_MARKETING_AMOUNT.toString(),
                    infraBrb: BRB_INFRA_AMOUNT.toString(),
                    infraStakedBrb: BRB_INFRA_STAKE_AMOUNT.toString(),
                    marketingToHouseBotBrb: HOUSE_BOT_BRB_AMOUNT.toString(),
                    futureLiquidityBrb: BRB_LIQUIDITY_AMOUNT.toString(),
                    usdcSeed: "deferred; no USDC spending or pair creation",
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
        JSON.stringify({ stage: "started", deployer: bootstrapAdmin, infrastructure: infraWallet, marketing: marketingWallet, deploymentNonce, preflight }, null, 2) + "\n",
        { flag: "wx" },
    );

    const gasFunding = await topUpGasWallets({ deployer, client: receiptClient,
        recipients: [
            { name: "keeper", address: keeperWallet, target: KEEPER_GAS_TARGET },
            { name: "infrastructure", address: infraWallet, target: INFRA_GAS_TARGET },
            { name: "marketing", address: marketingWallet, target: marketingFundingTarget },
        ], waitWrite });
    writeFileSync(journalPath, JSON.stringify({ stage: "wallets-funded", deployer: bootstrapAdmin,
        deploymentNonce, gasFunding, preflight }, null, 2) + "\n");

    const infrastructureVrf = await createInfrastructureVrfSubscription({ deployer, infrastructure,
        client: receiptClient, link: linkToken, coordinator: vrfCoordinator, waitWrite });
    const vrfSubscriptionId = infrastructureVrf.subscriptionId;
    const linkFundedJuels = infrastructureVrf.fundedJuels;
    console.log(`Infrastructure owns VRF subscription ${vrfSubscriptionId} funded with all ${linkFundedJuels} deployer LINK Juels`);

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

    await vrfAddConsumerIfNeeded(infrastructure, receiptClient, vrfCoordinator, vrfSubscriptionId, engine.address);

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

    await waitWrite(registry.write.createMarket(
        [{ asset: brb, bankAdmin: protocolAdmin, minBet: minBrb }], { account: deployer.account },
    ));
    const marketBrb = await registry.read.getMarket([1]);
    if (await registry.read.marketCount() !== 1 || marketBrb.asset.toLowerCase() !== brb.toLowerCase()) {
        throw new Error("Expected the BRB-only test market as market 1");
    }
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

    const infrastructureStake = await stakeInfrastructureBrb({ token: brb, bank: marketBrb.bank,
        infrastructure, client: receiptClient, amount: BRB_INFRA_STAKE_AMOUNT, waitWrite });
    const houseBotFunding = await fundHouseBot({ token: brb, marketing, houseBot: houseBotWallet,
        client: receiptClient, brbAmount: HOUSE_BOT_BRB_AMOUNT, ethTarget: HOUSE_BOT_GAS_TARGET,
        marketingEthReserve: MARKETING_GAS_TARGET, waitWrite });
    if (BigInt(houseBotFunding.marketingBrbRemaining) !== BRB_MARKETING_AMOUNT - HOUSE_BOT_BRB_AMOUNT) {
        throw new Error("Marketing BRB remainder does not match the approved house bot allocation");
    }
    const usdcAfter = await receiptClient.readContract({ address: usdc, abi: tokenReadAbi, functionName: "balanceOf", args: [bootstrapAdmin] });
    if (usdcAfter !== usdcBefore) throw new Error("Deployer USDC changed during the architecture-only deployment");
    const futureLiquidityBrb = await brbC.read.balanceOf([bootstrapAdmin]);
    if (futureLiquidityBrb !== BRB_LIQUIDITY_AMOUNT) throw new Error("Future BRB liquidity reserve changed unexpectedly");
    const factory = await viem.getContractAt("UniswapV2Factory", UNISWAP_V2_FACTORY);
    const usdcBrbPair = await factory.read.getPair([usdc, brb]);
    const daiBrbPair = await factory.read.getPair([dai, brb]);
    if (BigInt(usdcBrbPair) !== 0n || BigInt(daiBrbPair) !== 0n) {
        throw new Error("Unexpected DEX pair exists for the new BRB token");
    }

    const deploymentManifest = {
        network: "arbitrum-one",
        chainId: 42161,
        startBlock: deployBlock,
        startBlocks: { brb: deployBlock },
        deployer: bootstrapAdmin,
        deploymentMode: MAINNET_DEPLOYMENT_MODE,
        activationApproved: false,
        gasFunding,
        infrastructureStake,
        houseBotFunding,
        houseBotWallet,
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
            scanLimit, maxPayoutsPerCall: maxPayouts,
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
            banks: [marketBrb.bank],
        },
        markets: {
            brb: { marketId: 1, asset: brb, bank: marketBrb.bank, minBet: minBrb.toString() },
        },
        deferredMarkets: { usdc: { asset: usdc }, dai: { asset: dai } },
        liquidity: {
            dexPairCreationDeferred: true,
            usdcUntouched: true,
            deployerUsdcBefore: usdcBefore.toString(), deployerUsdcAfter: usdcAfter.toString(),
            futureLiquidityBrb: { owner: bootstrapAdmin, amount: futureLiquidityBrb.toString() },
            brbAllocation: {
                marketing: { wallet: marketingWallet, amount: BRB_MARKETING_AMOUNT.toString() },
                infra: { wallet: infraWallet, amount: BRB_INFRA_AMOUNT.toString(), staked: true, bank: marketBrb.bank },
            },
            lpVestingLockDeferred: true,
            note: "No DEX pair or stablecoin market created; infrastructure owns the BRB vault shares; deployer retains the future liquidity reserve",
        },
        vrf: {
            coordinator: vrfCoordinator,
            owner: infraWallet,
            linkTransferToInfrastructureHash: infrastructureVrf.transferHash,
            confirmations, callbackGasLimit,
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
        "BRB-only architecture configured; infrastructure allocation staked. No USDC spent and no DEX pair created. Activate the keeper with yarn deploy:cloudflare:arbitrum.",
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
