import { encodePacked, getCreate2Address, keccak256, type Address } from "viem";

/** Matches `UniswapV2TwapLib.PAIR_INIT_CODE_HASH` / vendored Uniswap V2 factory. */
export const UNISWAP_V2_PAIR_INIT_CODE_HASH =
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" as const;

export function uniswapV2PairAddress(factory: Address, tokenA: Address, tokenB: Address): Address {
    const [token0, token1] =
        tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    return getCreate2Address({
        bytecodeHash: UNISWAP_V2_PAIR_INIT_CODE_HASH,
        from: factory,
        salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    });
}
