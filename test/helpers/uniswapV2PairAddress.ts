import { readFileSync } from "node:fs";
import { join } from "node:path";

import { encodePacked, getCreate2Address, keccak256, type Address } from "viem";

import { vendoredUniswapV2PairInitCodeHash } from "./vendoredUniswapV2PairInitCodeHash";

/** Canonical Uniswap V2 pair init code hash (mainnet / production routers). */
export const UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH =
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" as const;

const GENERATED_HASH_PATH = join(__dirname, "uniswapV2PairInitCodeHash.generated.json");

/** Last `yarn sync:uniswap:pair-hash` output (optional; tests prefer live artifact hash). */
export function readGeneratedVendoredPairInitCodeHash(): `0x${string}` | undefined {
    try {
        const raw = readFileSync(GENERATED_HASH_PATH, "utf8");
        const parsed = JSON.parse(raw) as { initCodeHash?: string };
        if (typeof parsed.initCodeHash === "string" && parsed.initCodeHash.startsWith("0x")) {
            return parsed.initCodeHash as `0x${string}`;
        }
    } catch {
        /* optional file */
    }
    return undefined;
}

/** @deprecated Use `vendoredUniswapV2PairInitCodeHash()` or `readGeneratedVendoredPairInitCodeHash()`. */
export const UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH =
    readGeneratedVendoredPairInitCodeHash() ??
    ("0x6480cbf8cd4d6d78ca063f11e1e4931cc0c44670ad6d0bfdcce2307b75e944bf" as const);

/** @deprecated Use `UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH`. */
export const UNISWAP_V2_PAIR_INIT_CODE_HASH = UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH;

export function uniswapV2PairAddress(
    factory: Address,
    tokenA: Address,
    tokenB: Address,
    initCodeHash: `0x${string}`,
): Address {
    const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    return getCreate2Address({
        bytecodeHash: initCodeHash,
        from: factory,
        salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    });
}

/** Resolves pair CREATE2 address using the vendored pair bytecode from the current compile. */
export async function uniswapV2PairAddressVendored(
    factory: Address,
    tokenA: Address,
    tokenB: Address,
): Promise<Address> {
    const initCodeHash = await vendoredUniswapV2PairInitCodeHash();
    return uniswapV2PairAddress(factory, tokenA, tokenB, initCodeHash);
}
