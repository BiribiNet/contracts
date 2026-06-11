import { encodePacked, getCreate2Address, keccak256, type Address } from "viem";

/** Canonical Uniswap V2 pair init code hash (mainnet / production routers). */
export const UNISWAP_V2_CANONICAL_PAIR_INIT_CODE_HASH =
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" as const;

/** Vendored `UniswapV2Pair` from this repo (Arbitrum Sepolia local factory deploy only). */
export const UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH =
    "0x6480cbf8cd4d6d78ca063f11e1e4931cc0c44670ad6d0bfdcce2307b75e944bf" as const;

/** @deprecated Use `UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH` for local Sepolia factory tests. */
export const UNISWAP_V2_PAIR_INIT_CODE_HASH = UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH;

export function uniswapV2PairAddress(
    factory: Address,
    tokenA: Address,
    tokenB: Address,
    initCodeHash: `0x${string}` = UNISWAP_V2_VENDORED_PAIR_INIT_CODE_HASH,
): Address {
    const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    return getCreate2Address({
        bytecodeHash: initCodeHash,
        from: factory,
        salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    });
}
