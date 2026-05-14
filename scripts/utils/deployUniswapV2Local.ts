import type { PublicClient, WalletClient } from "viem";
import { getContract } from "viem";

import { viem } from "hardhat";

export type UniswapV2Deployed = {
    factory: `0x${string}`;
    weth: `0x${string}`;
    router: `0x${string}`;
};

/**
 * Deploy Uniswap V2 factory + WETH9 + Router02 from vendored sources under `contracts/vendor/`
 * (same bytecode layout as canonical Uniswap V2, compiled by this repo).
 */
export async function deployUniswapV2Local(deployer: WalletClient): Promise<UniswapV2Deployed> {
    if (!deployer.account) throw new Error("deployer has no account");

    const factory = await viem.deployContract("UniswapV2Factory", [deployer.account.address]);
    const weth = await viem.deployContract("WETH9");
    const router = await viem.deployContract("UniswapV2Router02", [factory.address, weth.address]);

    return {
        factory: factory.address,
        weth: weth.address,
        router: router.address,
    };
}

/** Optional sanity: router.factory() and router.WETH() match deployed addresses. */
export async function assertRouterLinks(
    publicClient: PublicClient,
    router: `0x${string}`,
    factory: `0x${string}`,
    weth: `0x${string}`,
): Promise<void> {
    const routerAbi = [
        { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
        { type: "function", name: "WETH", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    ] as const;
    const c = getContract({ address: router, abi: routerAbi, client: publicClient });
    const [f, w] = await Promise.all([c.read.factory(), c.read.WETH()]);
    if (f.toLowerCase() !== factory.toLowerCase() || w.toLowerCase() !== weth.toLowerCase()) {
        throw new Error("UniswapV2Router02 factory/WETH mismatch");
    }
}
