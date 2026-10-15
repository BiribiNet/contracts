import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { zeroAddress } from "viem";

import {
    CRE_KEYSTONE_FORWARDER,
    CRE_LANE_MAX_DRAIN_ITERATIONS,
    CRE_WRITE_GAS_LIMIT,
    DEFAULT_VRF_FUND_LINK,
    LINK_TOKEN,
    PAYOUT_LANE_COUNT,
    ROUND_DURATION_SECONDS,
    SEED_LIQUIDITY_BRB,
    SEED_LIQUIDITY_DAI,
    SEED_LIQUIDITY_USDC,
    UPKEEP_MAX_PAYOUTS_PER_CALL,
    USDC,
    VERIFY_DELAY_MS,
    VRF_CALLBACK_GAS_LIMIT,
    VRF_CONFIRMATIONS,
    VRF_COORDINATOR,
    VRF_KEY_HASH,
} from "./constants/arbitrumSepolia";
import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import { deployCreAutomation } from "./utils/deployCreAutomation";
import { writeCreWorkflowConfigs } from "./utils/writeCreWorkflowConfigs";
import { deployUniswapV2Local } from "./utils/deployUniswapV2Local";
import { seedBrbAssetPool } from "./utils/seedUniswapV2BrbPools";
import {
    vrfAddConsumerIfNeeded,
    vrfCreateSubscription,
    vrfFundSubscriptionWithLink,
} from "./utils/vrfSubscription";
import {
    encodeBankVaultProxyInitDataFromAsset,
    verifyProtocolProxies,
} from "./utils/proxyVerification";
import {
    buildRouletteEngineLibraryMap,
    verifyContractWithDelay,
    verifyRouletteLinkedLibraries,
    verifyUpgradeableBeaconWithDelay,
} from "./utils/verifyWithEtherscan";

/**
 * Arbitrum Sepolia (421614) protocol deploy — Chainlink / Circle USDC fixed in
 * `scripts/constants/arbitrumSepolia.ts`. Deploys vendored Uniswap V2 (no official V2 on this testnet).
 *
 * Hardhat vars: `BRB_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, optional `ETHERSCAN_API_KEY`.
 * Run: `yarn deploy:protocol:arbitrum-sepolia`
 */

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;

const FQ_UNISWAP_FACTORY = "contracts/vendor/uniswap-v2-core/UniswapV2Factory.sol:UniswapV2Factory" as const;
const FQ_WETH9 = "contracts/vendor/uniswap-v2-periphery/test/WETH9.sol:WETH9" as const;
const FQ_UNISWAP_ROUTER = "contracts/vendor/uniswap-v2-periphery/UniswapV2Router02.sol:UniswapV2Router02" as const;

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

    const verifyDelayMs = VERIFY_DELAY_MS;
    const runVerify = vars.has("ETHERSCAN_API_KEY");
    if (!runVerify) {
        console.warn("ETHERSCAN_API_KEY hardhat var not set — skipping Arbiscan verification.");
    }

    const vrfCoordinator = VRF_COORDINATOR;
    const linkToken = LINK_TOKEN;
    const creKeystoneForwarder = CRE_KEYSTONE_FORWARDER;
    const usdc = USDC;
    const infraRecipient = deployer.account.address;

    const uniswapDeployed = await deployUniswapV2Local(deployer);
    const router = uniswapDeployed.router;
    console.log("Deployed local Uniswap V2:", uniswapDeployed);

    const vrfSubscriptionId = await vrfCreateSubscription(deployer, publicClient, vrfCoordinator);
    const vrfSubscriptionCreatedByScript = true;
    console.log(`Created VRF subscription id: ${vrfSubscriptionId.toString()}`);
    const vrfInitialLinkJuels = DEFAULT_VRF_FUND_LINK;
    await vrfFundSubscriptionWithLink(
        deployer,
        publicClient,
        linkToken,
        vrfCoordinator,
        vrfSubscriptionId,
        vrfInitialLinkJuels,
    );
    console.log(
        `Funded VRF subscription ${vrfSubscriptionId.toString()} with ${vrfInitialLinkJuels.toString()} Juels LINK`,
    );

    const vrfKeyHash2Gwei = VRF_KEY_HASH;
    const vrfKeyHash30Gwei = VRF_KEY_HASH;
    const vrfKeyHash150Gwei = VRF_KEY_HASH;
    const callbackGasLimit = VRF_CALLBACK_GAS_LIMIT;
    const confirmations = VRF_CONFIRMATIONS;
    const roundDuration = ROUND_DURATION_SECONDS;
    const maxPayoutsPerCall = UPKEEP_MAX_PAYOUTS_PER_CALL;
    const payoutLaneCount = PAYOUT_LANE_COUNT;
    const creWorkflowLaneCount = PAYOUT_LANE_COUNT;
    const creLaneMaxDrainIterations = CRE_LANE_MAX_DRAIN_ITERATIONS;

    const brbC = await viem.deployContract("BRBToken", [deployer.account.address]);
    const brb = brbC.address;
    const deployedBrb = true;

    const mockDai = await viem.deployContract("MockDAI");
    const dai = mockDai.address;
    const deployedMockDai = true;
    console.log("Deployed MockDAI for market 2.");

    console.log("Seeding Uniswap V2 BRB pools on router", router);
    const usdcBrb = await seedBrbAssetPool(
        deployer,
        publicClient,
        {
            router,
            brb,
            asset: usdc,
            assetAmount: SEED_LIQUIDITY_USDC,
            brbAmount: SEED_LIQUIDITY_BRB,
            assetLabel: "USDC",
        },
        waitWrite,
    );
    const daiBrb = await seedBrbAssetPool(
        deployer,
        publicClient,
        {
            router,
            brb,
            asset: dai,
            assetAmount: SEED_LIQUIDITY_DAI,
            brbAmount: SEED_LIQUIDITY_BRB,
            assetLabel: "DAI",
            mintAssetToDeployer: true,
        },
        waitWrite,
    );
    const seededPools = { usdcBrb, daiBrb };
    console.log("LP tokens remain on the deployer — deploy LPVestingLock later and transfer when ready.");

    const {
        engine,
        engineImplementation,
        engineProxyInitData,
        scheduler,
        sideBet,
        sideBetImplementation,
        sideBetProxyInitData,
        linkedLibraries,
        brbReferral: deployedBrbReferral,
        registry,
        jackpotTreasury,
        funder,
    } = await deployRouletteEngine(
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
            maxPayoutsPerCall,
        },
        {
            protocolPrefix: {
                brb,
                router: router,
                admin: deployer.account.address,
            },
            deployBrbReferral: true,
            wireMockForwarder: false,
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

    await waitWrite(engine.write.setPayoutLaneCount([payoutLaneCount], { account: deployer.account }));
    console.log(`Payout parallel lanes: ${payoutLaneCount} on-chain, ${creWorkflowLaneCount} CRE workflow(s)`);

    const creAutomation = await deployCreAutomation({
        scheduler: scheduler.address,
        admin: deployer.account.address,
        keystoneForwarder: creKeystoneForwarder,
        wallet: deployer,
        publicClient,
        waitWrite,
    });

    writeCreWorkflowConfigs({
        network: "arbitrum-sepolia",
        scheduler: scheduler.address,
        receiver: creAutomation.automationReceiver,
        engine: engine.address,
        laneCount: creWorkflowLaneCount,
        writeGasLimit: CRE_WRITE_GAS_LIMIT,
        laneMaxDrainIterations: creLaneMaxDrainIterations,
        httpAuthorizedKeys: [deployer.account.address],
    });

    const minStable = 10n ** 6n;
    const minDai = 10n ** 18n;
    const minBrb = 10n ** 18n;

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
                    minBet: minDai,
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

    const tipJar = await viem.deployContract("TipJar", [brb, engine.address]);
    console.log(`Deployed TipJar at ${tipJar.address}`);

    const deployBlock = Number(await publicClient.getBlockNumber());
    const brbReferal =
        deployedBrbReferral;
    const sideBetAddr = await registry.read.SIDE_BET();

    const subgraphDeployment = {
        startBlock: deployBlock,
        startBlocks: {
            brb: deployBlock,
            roulette: deployBlock,
            stakedBRB: deployBlock,
            brbReferal: deployBlock,
            sideBet: deployBlock,
            jackpotFunder: deployBlock,
        },
        addresses: {
            brb,
            roulette: engine.address,
            registry: registry.address,
            scheduler: scheduler.address,
            stakedBRB: marketUsdc.bank,
            banks: [marketUsdc.bank, marketDai.bank, marketBrb.bank],
            brbReferal,
            automationReceiver: creAutomation.automationReceiver,
            creExecutionAuthority: creAutomation.creExecutionAuthority,
            jackpotTreasury: jackpotTreasury.address,
            jackpotFunder: funder.address,
            tipJar: tipJar.address,
            sideBet: sideBetAddr,
            uniswapRouter: router,
        },
        vrf: {
            coordinator: vrfCoordinator,
            linkToken,
            subscriptionId: vrfSubscriptionId.toString(),
        },
        markets: {
            usdc: { marketId: 1, asset: usdc, bank: marketUsdc.bank },
            dai: { marketId: 2, asset: dai, bank: marketDai.bank, mockDai: deployedMockDai },
            brb: { marketId: 3, asset: brb, bank: marketBrb.bank },
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

    console.log("Skipped Goldsky/subgraph sync — run sync:subgraph:arbitrum-sepolia separately when ready.");

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
        await verifyContractWithDelay(tipJar.address, [brb, engine.address], verifyDelayMs);
        if (deployedMockDai) {
            await verifyContractWithDelay(dai, [], verifyDelayMs);
        }
        if (deployedBrbReferral && deployedBrbReferral !== zeroAddress) {
            await verifyContractWithDelay(deployedBrbReferral, [engine.address], verifyDelayMs);
        }
        await verifyContractWithDelay(jackpotTreasury.address, [brb, engine.address, deployer.account.address], verifyDelayMs);
        await verifyContractWithDelay(
            funder.address,
            [engine.address, brb, router, jackpotTreasury.address, sideBet.address, deployer.account.address],
            verifyDelayMs,
        );
        await verifyContractWithDelay(
            registry.address,
            [deployer.account.address, engine.address, sideBet.address],
            verifyDelayMs,
        );
        await verifyContractWithDelay(vaultImpl.address, [], verifyDelayMs);
        await verifyUpgradeableBeaconWithDelay(
            beacon.address,
            [vaultImpl.address, deployer.account.address],
            verifyDelayMs,
        );

        await verifyRouletteLinkedLibraries(linkedLibraries, verifyDelayMs);

        const [usdcVaultInit, daiVaultInit, brbVaultInit] = await Promise.all([
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: usdc,
                marketId: 1,
                engine: engine.address,
                bankAdmin: deployer.account.address,
                minBet: minStable,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: dai,
                marketId: 2,
                engine: engine.address,
                bankAdmin: deployer.account.address,
                minBet: minDai,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: brb,
                marketId: 3,
                engine: engine.address,
                bankAdmin: deployer.account.address,
                minBet: minBrb,
                sideBetController: sideBet.address,
            }),
        ]);

        console.log("Verifying proxies (RouletteEngine, SideBet, bank vaults)…");
        await verifyProtocolProxies({
            delayMs: verifyDelayMs,
            engineProxy: engine.address,
            engineImplementation: engineImplementation.address,
            engineInitData: engineProxyInitData,
            engineImplCtorArgs: [
                vrfCoordinator,
                vrfKeyHash2Gwei,
                vrfKeyHash30Gwei,
                vrfKeyHash150Gwei,
                confirmations,
                deployedBrbReferral,
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
            [engine.address, sideBet.address, deployer.account.address, 25, 60],
            verifyDelayMs,
        );
        await verifyContractWithDelay(
            creAutomation.automationReceiver,
            [creKeystoneForwarder],
            verifyDelayMs,
            "contracts/chainlink/cre/AutomationReceiver.sol:AutomationReceiver",
        );
        await verifyContractWithDelay(
            creAutomation.creExecutionAuthority,
            [deployer.account.address],
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
                uniswapPools: seededPools
                    ? {
                          usdcBrb: {
                              pair: seededPools.usdcBrb.pair,
                              lpBalance: seededPools.usdcBrb.liquidity.toString(),
                              lpHolder: seededPools.usdcBrb.lpRecipient,
                          },
                          daiBrb: {
                              pair: seededPools.daiBrb.pair,
                              lpBalance: seededPools.daiBrb.liquidity.toString(),
                              lpHolder: seededPools.daiBrb.lpRecipient,
                          },
                          lpVestingLockDeferred: true,
                      }
                    : undefined,
                tipJar: tipJar.address,
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
                    roulettePayoutSweepLib: linkedLibraries.roulettePayoutSweepLib,
                    rouletteJackpotCollectLib: linkedLibraries.rouletteJackpotCollectLib,
                    rouletteExposureLib: linkedLibraries.rouletteExposureLib,
                    rouletteUpkeepScanLib: linkedLibraries.rouletteUpkeepScanLib,
                },
                creAutomation,
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
                        ? vrfInitialLinkJuels > 0n
                            ? `VRF subscription was created and funded with ${vrfInitialLinkJuels.toString()} Juels LINK (override with VRF_INITIAL_LINK_JUELS).`
                            : "VRF subscription was created on-chain; set VRF_INITIAL_LINK_JUELS or fund via vrf.chain.link."
                        : "VRF subscription id was taken from VRF_SUBSCRIPTION_ID; ensure it is funded and the deployer is the subscription owner (required for addConsumer).",
                    "Deploy CRE workflows (lane LOG + HTTP trigger-vrf; configs written under cre/workflows/)",
                    "Fund each bank vault with initial liquidity; configure min bets / vault params as needed",
                    seededPools
                        ? "BRB/USDC and BRB/DAI Uniswap pools were seeded; LP is on the deployer — deploy LPVestingLock later and transfer LP when ready"
                        : "Create BRB/USDC and BRB/DAI pools on your Uniswap V2 router (or unset SKIP_UNISWAP_LIQUIDITY) and tune BRB_RATIO_MARKET_1 / BRB_RATIO_MARKET_2",
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
