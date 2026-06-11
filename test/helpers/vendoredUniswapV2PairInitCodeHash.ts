import hre from "hardhat";
import { keccak256 } from "viem";

const UNISWAP_V2_PAIR_FQN = "contracts/vendor/uniswap-v2-core/UniswapV2Pair.sol:UniswapV2Pair" as const;

let cached: `0x${string}` | undefined;

/** `keccak256(type(UniswapV2Pair).creationCode)` for the vendored pair in this repo's current compile. */
export async function vendoredUniswapV2PairInitCodeHash(): Promise<`0x${string}`> {
    if (cached) return cached;
    const artifact = await hre.artifacts.readArtifact(UNISWAP_V2_PAIR_FQN);
    cached = keccak256(artifact.bytecode as `0x${string}`);
    return cached;
}
