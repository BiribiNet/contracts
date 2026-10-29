import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, isAddress, parseEther, parseUnits, type Address, type Hex } from "viem";

/**
 * Fixed Arbitrum One (42161) addresses for protocol deploy.
 * Sources (verify before broadcast):
 * - Uniswap V2: https://developers.uniswap.org/docs/protocols/v2/deployments
 * - Chainlink VRF v2.5: https://docs.chain.link/vrf/v2-5/supported-networks
 * - Circle USDC / Maker DAI: canonical Arbitrum One deployments
 *
 * Automation: Cloudflare Workers in keeper mode (no Chainlink CRE).
 * Only the signing private key is read from Hardhat vars; public configuration lives here.
 */

/** https://developers.uniswap.org/docs/protocols/v2/deployments — Arbitrum Router02 */
export const UNISWAP_V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as const;
/** https://developers.uniswap.org/docs/protocols/v2/deployments — Arbitrum Factory */
export const UNISWAP_V2_FACTORY = "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9" as const;

/** https://docs.chain.link/vrf/v2-5/supported-networks — Arbitrum Mainnet */
export const LINK_TOKEN = "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4" as const;
export const VRF_COORDINATOR = "0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e" as const;
export const VRF_KEY_HASH_2_GWEI =
    "0x9e9e46732b32662b9adc6f3abdf6c5e926a666d174a4d6b8e39c4cca76a38897" as Hex;
export const VRF_KEY_HASH_30_GWEI =
    "0x8472ba59cf7134dfe321f4d61a430c4857e8b19cdd5230b09952a92671c24409" as Hex;
export const VRF_KEY_HASH_150_GWEI =
    "0xe9f223d7d83ec85c4f78042a4845af3a1c8df7757b4997b815ce4b8d07aca68c" as Hex;

/** Circle native USDC on Arbitrum One */
export const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
/** Maker DAI on Arbitrum One */
export const DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as const;

/**
 * Fixed genesis recipient addresses (not loaded from env); verify control before broadcast.
 * Genesis BRB: 300_000 each; 2_400_000 remains with the deployer for future liquidity.
 */
export const MARKETING_WALLET: Address = "0xB43800e00EA2502775385fEa1A93594eC6D73339";
export const HOUSE_BOT_WALLET: Address = "0xEc52D51bA55bef8108aeC20EbDeE79D84a443B7f";
export const INFRA_WALLET: Address = "0xD7eB223002c71d539894a2dbA5accb6CF032b5d6";

/**
 * Cloudflare Workers keeper EOA — must match `KEEPER_PRIVATE_KEY` on the Worker.
 * Approved on `CreExecutionAuthority` during protocol deploy.
 */
export const KEEPER_WALLET: Address = "0x29984d0C50DdAA5be680b750025dC88D16c57aB8";

/** Genesis BRB split (matches `BRBToken.TOTAL_SUPPLY` = 3_000_000). */
export const BRB_LIQUIDITY_AMOUNT = parseUnits("2400000", 18);
export const BRB_MARKETING_AMOUNT = parseUnits("300000", 18);
export const BRB_INFRA_AMOUNT = parseUnits("300000", 18);

export const VRF_CALLBACK_GAS_LIMIT = 2_500_000;
/** Chainlink Arbitrum One minimum is 1 — https://docs.chain.link/vrf/v2-5/supported-networks */
export const VRF_CONFIRMATIONS = 1;
export const ROUND_DURATION_SECONDS = 60;
export const PAYOUT_LANE_COUNT = 1;
export const UPKEEP_SCAN_LIMIT = 25;
export const UPKEEP_MAX_PAYOUTS_PER_CALL = 60;
export const KEEPER_MAX_DRAIN_ITERATIONS = 5;
export const VERIFY_DELAY_MS = 3_000;

export const MIN_BET_USDC = parseUnits("1", 6);
export const MIN_BET_DAI = parseUnits("1", 18);
export const MIN_BET_BRB = parseUnits("1", 18);

/** Verified Biribi Cloudflare account and dedicated Arbitrum One worker. */
export const CLOUDFLARE_ACCOUNT_ID = "565dcec5f878e204eb97f74b00e25a58" as const;
export const CLOUDFLARE_WORKER_NAME = "biribi-round-watcher-arbitrum-one" as const;

/** Dedicated RPC Worker; its authentication credential is never committed. */
export const ARBITRUM_RPC_FALLBACK_WORKER =
    "https://biribi-rpc-fallback-arbitrum-one.soft-thunder-4aae.workers.dev" as const;

/** Optional local credential, separate from all fixed public addresses and RPC URLs. */
const rpcCredentialPath = join(__dirname, "arbitrumOne.local.json");
function loadRpcProxyCredential(): string | undefined {
    if (!existsSync(rpcCredentialPath)) return undefined;
    const config: unknown = JSON.parse(readFileSync(rpcCredentialPath, "utf8"));
    if (!config || typeof config !== "object" || !("rpcProxyApiKey" in config) ||
        typeof config.rpcProxyApiKey !== "string" || config.rpcProxyApiKey.length < 16) {
        throw new Error("Invalid local Arbitrum RPC proxy credential file");
    }
    return config.rpcProxyApiKey;
}
const rpcProxyCredential = loadRpcProxyCredential();
/** Public deployments work without the optional authenticated proxy credential. No env lookup. */
export const ARBITRUM_RPC_URLS = [
    ...(rpcProxyCredential ? [`${ARBITRUM_RPC_FALLBACK_WORKER}/?api_key=${encodeURIComponent(rpcProxyCredential)}`] : []),
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://1rpc.io/arb",
    "https://arbitrum.llamarpc.com",
    "https://arbitrum.drpc.org",
] as const;
export const ARBITRUM_RPC_URL = ARBITRUM_RPC_URLS[0];
export const MIN_DEPLOYER_ETH = parseEther("0.02");
export const MIN_KEEPER_ETH = parseEther("0.005");
/** Approved gas balances; the deployer sends only each wallet's shortfall. */
export const KEEPER_GAS_TARGET = parseEther("0.005");
export const INFRA_GAS_TARGET = parseEther("0.001");
export const MARKETING_GAS_TARGET = parseEther("0.001");
export const HOUSE_BOT_GAS_TARGET = parseEther("0.001");
export const MARKETING_TRANSFER_GAS_BUFFER = parseEther("0.0001");
export const HOUSE_BOT_BRB_AMOUNT = parseUnits("1000", 18);
/** Initial mainnet test registers only BRB. Stablecoin markets and DEX liquidity come later. */
export const MAINNET_DEPLOYMENT_MODE = "brb-test" as const;
export const BRB_INFRA_STAKE_AMOUNT = BRB_INFRA_AMOUNT;


export function assertGenesisWalletsConfigured() {
    const wallets = { marketingWallet: MARKETING_WALLET, infraWallet: INFRA_WALLET, keeperWallet: KEEPER_WALLET, houseBotWallet: HOUSE_BOT_WALLET };
    for (const [name, value] of Object.entries(wallets)) {
        if (!value || !isAddress(value) || BigInt(value) === 0n) {
            throw new Error(`Set the actual ${name} in scripts/constants/arbitrumOne.ts before deployment`);
        }
        getAddress(value);
    }
    if (new Set(Object.values(wallets).map(address => address.toLowerCase())).size !== Object.keys(wallets).length) {
        throw new Error("Genesis recipients, house bot and keeper must be distinct");
    }
    return wallets;
}
