import type { PublicClient, WalletClient } from "viem";
import { getContract, maxUint256, parseAbi } from "viem";

const routerAbi = parseAbi([
    "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
    "function factory() external pure returns (address)",
]);

const factoryAbi = parseAbi([
    "function getPair(address tokenA, address tokenB) external view returns (address pair)",
    "function createPair(address tokenA, address tokenB) external returns (address pair)",
]);

const erc20Abi = parseAbi([
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)",
    "function mint(address to, uint256 amount) external",
]);

export type SeedBrbPoolParams = {
    router: `0x${string}`;
    brb: `0x${string}`;
    asset: `0x${string}`;
    assetAmount: bigint;
    brbAmount: bigint;
    assetLabel: string;
    /** When true, call `mint(deployer, assetAmount)` if the asset contract exposes it (e.g. MockDAI). */
    mintAssetToDeployer?: boolean;
};

async function ensureAllowance(
    deployer: WalletClient,
    publicClient: PublicClient,
    token: `0x${string}`,
    spender: `0x${string}`,
    required: bigint,
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>,
): Promise<void> {
    if (!deployer.account) throw new Error("deployer has no account");
    const tokenContract = getContract({ address: token, abi: erc20Abi, client: publicClient });
    const allowance = await tokenContract.read.allowance([deployer.account.address, spender]);
    if (allowance >= required) return;
    await waitWrite(
        deployer.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, maxUint256],
            account: deployer.account,
            chain: publicClient.chain,
        }),
    );
}

async function ensureBalance(
    deployer: WalletClient,
    publicClient: PublicClient,
    token: `0x${string}`,
    required: bigint,
    label: string,
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>,
    mintToDeployer?: boolean,
): Promise<void> {
    if (!deployer.account) throw new Error("deployer has no account");
    const tokenContract = getContract({ address: token, abi: erc20Abi, client: publicClient });
    let balance = await tokenContract.read.balanceOf([deployer.account.address]);
    if (balance >= required) return;

    if (mintToDeployer) {
        const shortfall = required - balance;
        await waitWrite(
            deployer.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: "mint",
                args: [deployer.account.address, shortfall],
                account: deployer.account,
                chain: publicClient.chain,
            }),
        );
        balance = await tokenContract.read.balanceOf([deployer.account.address]);
        if (balance >= required) return;
    }

    throw new Error(
        `Deployer ${label} balance ${balance.toString()} is below required ${required.toString()} for Uniswap liquidity seeding.`,
    );
}

/** Creates the asset/BRB pair if missing, approves the router, and adds liquidity. */
export async function seedBrbAssetPool(
    deployer: WalletClient,
    publicClient: PublicClient,
    params: SeedBrbPoolParams,
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>,
): Promise<{ pair: `0x${string}`; liquidity: bigint }> {
    if (!deployer.account) throw new Error("deployer has no account");

    const router = getContract({ address: params.router, abi: routerAbi, client: publicClient });
    const factoryAddress = await router.read.factory();
    const factory = getContract({ address: factoryAddress, abi: factoryAbi, client: publicClient });

    let pair = await factory.read.getPair([params.asset, params.brb]);
    if (pair === "0x0000000000000000000000000000000000000000") {
        await waitWrite(
            deployer.writeContract({
                address: factoryAddress,
                abi: factoryAbi,
                functionName: "createPair",
                args: [params.asset, params.brb],
                account: deployer.account,
                chain: publicClient.chain,
            }),
        );
        pair = await factory.read.getPair([params.asset, params.brb]);
        if (pair === "0x0000000000000000000000000000000000000000") {
            throw new Error(`Failed to create ${params.assetLabel}/BRB pair on factory ${factoryAddress}`);
        }
        console.log(`Created ${params.assetLabel}/BRB pair at ${pair}`);
    } else {
        console.log(`${params.assetLabel}/BRB pair already exists at ${pair}`);
    }

    await ensureBalance(
        deployer,
        publicClient,
        params.asset,
        params.assetAmount,
        params.assetLabel,
        waitWrite,
        params.mintAssetToDeployer,
    );
    await ensureBalance(deployer, publicClient, params.brb, params.brbAmount, "BRB", waitWrite);

    await ensureAllowance(deployer, publicClient, params.asset, params.router, params.assetAmount, waitWrite);
    await ensureAllowance(deployer, publicClient, params.brb, params.router, params.brbAmount, waitWrite);

    const block = await publicClient.getBlock();
    const deadline = BigInt(block.timestamp) + 3600n;
    const amountAMin = (params.assetAmount * 95n) / 100n;
    const amountBMin = (params.brbAmount * 95n) / 100n;

    const hash = await deployer.writeContract({
        address: params.router,
        abi: routerAbi,
        functionName: "addLiquidity",
        args: [
            params.asset,
            params.brb,
            params.assetAmount,
            params.brbAmount,
            amountAMin,
            amountBMin,
            deployer.account.address,
            deadline,
        ],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await waitWrite(Promise.resolve(hash));

    const pairAbi = parseAbi(["function balanceOf(address account) external view returns (uint256)"]);
    const pairContract = getContract({ address: pair, abi: pairAbi, client: publicClient });
    const liquidity = await pairContract.read.balanceOf([deployer.account.address]);

    console.log(
        `Seeded ${params.assetLabel}/BRB liquidity: ${params.assetAmount.toString()} asset wei + ${params.brbAmount.toString()} BRB wei (LP balance ${liquidity.toString()})`,
    );

    return { pair, liquidity };
}
