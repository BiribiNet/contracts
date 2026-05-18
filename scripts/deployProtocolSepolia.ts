import "dotenv/config";

import { viem } from "hardhat";
import { isAddress, maxUint256, parseAbi, parseUnits } from "viem";

import { deployRouletteEngine } from "./utils/deployRouletteEngine";
import { vrfAddConsumerIfNeeded, vrfCreateSubscription, vrfFundSubscriptionWithLink } from "./utils/vrfSubscription";

/**
 * Full protocol deploy for Ethereum Sepolia (chain 11155111): RouletteEngine, registry,
 * three markets (USDC, DAI, BRB), jackpot stack, upkeep manager + three automation lanes.
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` and `hardhat vars set SEPOLIA_RPC_URL` (see hardhat.network.ts)
 * - LINK on the deployer for `registerLaneUpkeep` (manager uses `transferFrom` from deployer; script `approve`s the manager)
 * - Sufficient Sepolia ETH for gas
 *
 * Run: `yarn deploy:protocol:sepolia`
 *
 * VRF: if `VRF_SUBSCRIPTION_ID` is unset, the script calls the coordinator’s `createSubscription()` and uses
 * the new id for `RouletteEngine`. After deploy it calls `addConsumer` for the engine (owner = deployer).
 * Optional `VRF_INITIAL_LINK_JUELS` funds the subscription via LINK `transferAndCall`.
 *
 * Router: default is Uniswap V2 `SwapRouter` on Sepolia (`0xeE567…`). Override with `UNISWAP_V2_ROUTER`.
 *
 * Env (optional overrides — defaults follow Chainlink + common Sepolia test tokens):
 * - VRF_SUBSCRIPTION_ID: omit to auto-create a subscription on the coordinator
 * - VRF_INITIAL_LINK_JUELS: optional LINK (Juels) to fund the subscription
 * - LINK_TOKEN, VRF_COORDINATOR, KEEPER_REGISTRAR, KEEPER_REGISTRY
 * - VRF_KEY_HASH (optional legacy: used as default for all three lanes when lane-specific vars unset)
 * - VRF_KEY_HASH_2_GWEI, VRF_KEY_HASH_30_GWEI, VRF_KEY_HASH_150_GWEI (engine picks by `tx.gasprice`, same tiers as legacy roulette)
 * - USDC_TOKEN, DAI_TOKEN
 * - BRB_TOKEN (omit to deploy new BRBToken minted to deployer)
 * - UNISWAP_V2_ROUTER
 * - BRB_RATIO_MARKET_1, BRB_RATIO_MARKET_2
 * - INFRA_RECIPIENT, VRF_CALLBACK_GAS_LIMIT, VRF_CONFIRMATIONS, ROUND_DURATION_SECONDS
 */

const SEPOLIA_CHAIN_ID = 11155111n;

/** Chainlink docs: VRF v2.5 subscription on Ethereum Sepolia */
const DEFAULT_LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789" as const;
const DEFAULT_VRF_COORDINATOR = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B" as const;
/** Sepolia subscription 500 gwei lane — see Chainlink VRF supported networks; used as default for each tier when unset. */
const DEFAULT_VRF_KEY_HASH =
    "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae" as const;
/** Chainlink Automation v2.1 on Ethereum Sepolia */
const DEFAULT_KEEPER_REGISTRY = "0x86EFBD0b6736Bed994962f9797049422A3A8E8Ad" as const;
const DEFAULT_KEEPER_REGISTRAR = "0xb0E49c5D0d05cbc241d68c05BC5BA1d1B7B72976" as const;

/** Uniswap V2 SwapRouter on Ethereum Sepolia (user-supplied; override via UNISWAP_V2_ROUTER). */
const DEFAULT_UNISWAP_V2_ROUTER = "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3" as const;

/** Circle USDC on Ethereum Sepolia — verify on Etherscan; override with USDC_TOKEN if needed */
const DEFAULT_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
/** Common Sepolia DAI test token — override with DAI_TOKEN if you use another */
const DEFAULT_DAI = "0x776b6fc2ed15d6bb5fc32e0c89de68683118c62a" as const;

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
    const legacy = process.env.VRF_KEY_HASH?.trim();
    const legacyOk =
        legacy &&
        legacy.startsWith("0x") &&
        legacy.length === 66 &&
        /^0x[0-9a-fA-F]{64}$/.test(legacy);
    const laneDefault = (legacyOk ? (legacy as `0x${string}`) : DEFAULT_VRF_KEY_HASH);
    return [
        envBytes32Or("VRF_KEY_HASH_2_GWEI", laneDefault),
        envBytes32Or("VRF_KEY_HASH_30_GWEI", laneDefault),
        envBytes32Or("VRF_KEY_HASH_150_GWEI", laneDefault),
    ] as const;
}

async function main() {
    const publicClient = await viem.getPublicClient();
    const walletClients = await viem.getWalletClients();
    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== SEPOLIA_CHAIN_ID) {
        throw new Error(`This script targets Ethereum Sepolia (11155111). Current chainId: ${chainId}`);
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
            "Deployer Sepolia ETH balance is 0 — fund it for gas. Many RPCs return `gas required exceeds allowance (0)` on eth_estimateGas when the sender cannot pay.",
        );
    }

    const vrfCoordinator = envAddressOrDefault("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);
    const linkToken = envAddressOrDefault("LINK_TOKEN", DEFAULT_LINK);
    const keeperRegistrar = envAddressOrDefault("KEEPER_REGISTRAR", DEFAULT_KEEPER_REGISTRAR);
    const keeperRegistry = envAddressOrDefault("KEEPER_REGISTRY", DEFAULT_KEEPER_REGISTRY);
    const usdc = envAddressOrDefault("USDC_TOKEN", DEFAULT_USDC);
    const dai = envAddressOrDefault("DAI_TOKEN", DEFAULT_DAI);
    const router = envAddressOrDefault("UNISWAP_V2_ROUTER", DEFAULT_UNISWAP_V2_ROUTER);

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
    const callbackGasLimit = Number(envBigIntOr("VRF_CALLBACK_GAS_LIMIT", 2_000_000n));
    const confirmations = Number(envBigIntOr("VRF_CONFIRMATIONS", 3n));
    const roundDuration = Number(envBigIntOr("ROUND_DURATION_SECONDS", 60n));

    let brb: `0x${string}`;
    if (brbAddressEnv) {
        brb = brbAddressEnv;
    } else {
        const brbC = await viem.deployContract("BRBToken", [deployer.account.address]);
        brb = brbC.address;
    }

    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [brb, deployer.account.address]);

    const funder = await viem.deployContract("BRBJackpotFunder", [
        "0x0000000000000000000000000000000000000000",
        brb,
        router,
        jackpotTreasury.address,
        deployer.account.address,
    ]);

    const registry = await viem.deployContract("MarketRegistry", [deployer.account.address]);

    const vaultImpl = await viem.deployContract("BankVault4626");
    const beacon = await viem.deployContract("UpgradeableBeacon", [vaultImpl.address, deployer.account.address]);
    await waitWrite(registry.write.setVaultBeacon([beacon.address], { account: deployer.account }));
    const vaultBeaconOnChain = await registry.read.vaultBeacon();
    if (vaultBeaconOnChain.toLowerCase() !== beacon.address.toLowerCase()) {
        throw new Error(
            `setVaultBeacon did not persist: registry has ${vaultBeaconOnChain}, expected beacon ${beacon.address}. Check deployer is registry admin.`,
        );
    }

    const { engine, scheduler } = await deployRouletteEngine(
        [vrfKeyHash2Gwei, vrfKeyHash30Gwei, vrfKeyHash150Gwei],
        [
            registry.address,
            jackpotTreasury.address,
            funder.address,
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
    );

    await vrfAddConsumerIfNeeded(deployer, publicClient, vrfCoordinator, vrfSubscriptionId, engine.address);

    await waitWrite(jackpotTreasury.write.setEngine([engine.address], { account: deployer.account }));
    await waitWrite(funder.write.setEngine([engine.address], { account: deployer.account }));
    await waitWrite(registry.write.setEngine([engine.address], { account: deployer.account }));

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

    await waitWrite(
        registry.write.createMarket(
            [
                {
                    asset: usdc,
                    bankAdmin: deployer.account.address,
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
                },
            ],
            { account: deployer.account },
        ),
    );


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

    await waitWrite(
        upkeepManager.write.registerLaneUpkeep([0n, 1_800_000, parseUnits("1", 18), deployer.account.address]),
    );
    await waitWrite(
        upkeepManager.write.registerLaneUpkeep([1n, 1_800_000, parseUnits("1", 18), deployer.account.address]),
    );
    await waitWrite(
        upkeepManager.write.registerLaneUpkeep([2n, 1_800_000, parseUnits("1", 18), deployer.account.address]),
    );

    console.log("Ethereum Sepolia protocol deployment complete");
    console.log(
        JSON.stringify(
            {
                chainId: Number(SEPOLIA_CHAIN_ID),
                registry: registry.address,
                engine: engine.address,
                scheduler: scheduler.address,
                upkeepManager: upkeepManager.address,
                jackpotTreasury: jackpotTreasury.address,
                brb,
                jackpotFunder: funder.address,
                uniswapRouter: router,
                markets: {
                    usdc: { marketId: 1, asset: usdc, bank: marketUsdc.bank },
                    dai: { marketId: 2, asset: dai, bank: marketDai.bank },
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
                    "Create BRB/USDC and BRB/DAI pools on Uniswap V2 (this router) and tune BRB_RATIO_MARKET_1 / BRB_RATIO_MARKET_2 to match pool economics",
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
