import { parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { UNISWAP_V2_FACTORY, UNISWAP_V2_ROUTER, USDC } from "../constants/arbitrumOne";
const tokenAbi = parseAbi(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
const factoryAbi = parseAbi(["function getPair(address,address) view returns(address)", "function createPair(address,address) returns(address)"]);
const routerAbi = parseAbi(["function factory() view returns(address)", "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns(uint256,uint256,uint256)"]);
const pairAbi = parseAbi(["function token0() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)", "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)"]);

/** Initial real V2 liquidity, exact approvals/amounts, LP minted directly to the deployer. No vesting contract. */
export async function seedMainnetBrbUsdcPool(params: {
    deployer: WalletClient; client: PublicClient; brb: Address; brbAmount: bigint; usdcAmount: bigint;
    waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    const { deployer, client, brb, brbAmount, usdcAmount, waitWrite } = params;
    const account = deployer.account;
    if (!account || brbAmount <= 0n || usdcAmount <= 0n) throw new Error("Explicit positive liquidity amounts and deployment signer required");
    const factory = await client.readContract({ address: UNISWAP_V2_ROUTER, abi: routerAbi, functionName: "factory" });
    if (factory.toLowerCase() !== UNISWAP_V2_FACTORY.toLowerCase()) throw new Error("Uniswap router factory mismatch");
    const balance = (token: Address, owner: Address) => client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    const [brbBefore, usdcBefore] = await Promise.all([balance(brb, account.address), balance(USDC, account.address)]);
    if (brbBefore < brbAmount || usdcBefore < usdcAmount) throw new Error("Deployer balances below approved liquidity amounts");
    let pair = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [brb, USDC] });
    if (BigInt(pair) === 0n) {
        await waitWrite(deployer.writeContract({ account, chain: client.chain, address: factory, abi: factoryAbi,
            functionName: "createPair", args: [brb, USDC],
            gas: await client.estimateContractGas({ account, address: factory, abi: factoryAbi, functionName: "createPair", args: [brb, USDC] }) }));
        pair = await client.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [brb, USDC] });
    }
    if (BigInt(pair) === 0n) throw new Error("Pair creation read-back failed");
    if (await client.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }) !== 0n ||
        await balance(brb, pair) !== 0n || await balance(USDC, pair) !== 0n) throw new Error("Initial pair must be empty; inspect existing liquidity before any seeding");
    for (const [token, amount] of [[brb, brbAmount], [USDC, usdcAmount]] as const) {
        await waitWrite(deployer.writeContract({ account, chain: client.chain, address: token, abi: tokenAbi,
            functionName: "approve", args: [UNISWAP_V2_ROUTER, amount],
            gas: await client.estimateContractGas({ account, address: token, abi: tokenAbi, functionName: "approve", args: [UNISWAP_V2_ROUTER, amount] }) }));
    }
    const deadline = (await client.getBlock()).timestamp + 600n;
    // Exact minimums protect the explicitly approved initial ratio; LP recipient is always the deployer.
    const args = [brb, USDC, brbAmount, usdcAmount, brbAmount, usdcAmount, account.address, deadline] as const;
    await waitWrite(deployer.writeContract({ account, chain: client.chain, address: UNISWAP_V2_ROUTER,
        abi: routerAbi, functionName: "addLiquidity", args,
        gas: await client.estimateContractGas({ account, address: UNISWAP_V2_ROUTER, abi: routerAbi, functionName: "addLiquidity", args }) }));
    const [token0, reserves, supply, lpBalance] = await Promise.all([
        client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [account.address] }),
    ]);
    const [brbReserve, usdcReserve] = token0.toLowerCase() === brb.toLowerCase() ? reserves : [reserves[1], reserves[0]];
    if (brbReserve !== brbAmount || usdcReserve !== usdcAmount || lpBalance <= 0n || supply - lpBalance !== 1000n ||
        brbBefore - await balance(brb, account.address) !== brbAmount || usdcBefore - await balance(USDC, account.address) !== usdcAmount) throw new Error("Initial liquidity amounts or deployer LP ownership read-back failed");
    for (const token of [brb, USDC]) {
        if (await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account.address, UNISWAP_V2_ROUTER] }) !== 0n) throw new Error("Unexpected remaining router allowance");
    }
    return { pair, router: UNISWAP_V2_ROUTER, factory, brbAmount: brbAmount.toString(), usdcAmount: usdcAmount.toString(),
        lpRecipient: account.address, lpBalance: lpBalance.toString(), minimumLiquidityBurned: "1000", lpVestingLockDeployed: false, lpVestingLockFunded: false };
}
