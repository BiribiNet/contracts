import { parseUnits, type Hex } from "viem";

import { CRE_KEYSTONE_FORWARDER_ARBITRUM_SEPOLIA } from "../utils/deployCreAutomation";

/**
 * Fixed Arbitrum Sepolia (421614) addresses.
 * Sources:
 * - Chainlink VRF v2.5: https://docs.chain.link/vrf/v2-5/supported-networks
 * - Circle USDC faucet docs / canonical Sepolia USDC
 * - CRE KeystoneForwarder: Chainlink Forwarder Directory
 *
 * Uniswap V2: no official Uniswap V2 deployment on Arbitrum Sepolia — deploy script
 * deploys vendored factory/router locally unless you hardcode a known test router below.
 *
 * Hardhat vars: `BRB_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, optional `ETHERSCAN_API_KEY`.
 */

/** https://docs.chain.link/vrf/v2-5/supported-networks — Arbitrum Sepolia */
export const LINK_TOKEN = "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E" as const;
export const VRF_COORDINATOR = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as const;
/** Arbitrum Sepolia 50 gwei lane — used for all three engine gas tiers on testnet */
export const VRF_KEY_HASH =
    "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" as Hex;

export const CRE_KEYSTONE_FORWARDER = CRE_KEYSTONE_FORWARDER_ARBITRUM_SEPOLIA;

/** Circle USDC on Arbitrum Sepolia */
export const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;

export const VRF_CALLBACK_GAS_LIMIT = 2_500_000;
export const VRF_CONFIRMATIONS = 1;
export const ROUND_DURATION_SECONDS = 60;
export const PAYOUT_LANE_COUNT = 10;
export const UPKEEP_MAX_PAYOUTS_PER_CALL = 60;
export const CRE_LANE_MAX_DRAIN_ITERATIONS = 5;
export const CRE_WRITE_GAS_LIMIT = "2500000";
export const VERIFY_DELAY_MS = 8_000;

export const SEED_LIQUIDITY_BRB = parseUnits("1000", 18);
export const SEED_LIQUIDITY_USDC = parseUnits("10", 6);
export const SEED_LIQUIDITY_DAI = parseUnits("10", 18);
export const DEFAULT_VRF_FUND_LINK = 5n * 10n ** 18n;
