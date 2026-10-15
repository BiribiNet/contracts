import { writeFileSync } from "node:fs";
import { createPublicClient, parseAbi } from "viem";
import { arbitrum } from "viem/chains";
import { DAI, LINK_TOKEN, UNISWAP_V2_FACTORY, UNISWAP_V2_ROUTER, USDC, VRF_COORDINATOR, VRF_KEY_HASH_2_GWEI, VRF_KEY_HASH_30_GWEI, VRF_KEY_HASH_150_GWEI, VRF_CALLBACK_GAS_LIMIT, VRF_CONFIRMATIONS } from "./constants/arbitrumOne";
import { createRpcFallback, resolveArbitrumRpcUrls } from "./utils/rpcFallback";

async function main() {
    const client = createPublicClient({
        chain: arbitrum,
        transport: createRpcFallback(resolveArbitrumRpcUrls(), arbitrum.id),
    });
    if (await client.getChainId() !== 42161) throw new Error("Wrong chain");
    const block = await client.getBlock();
    const dependencies = { router: UNISWAP_V2_ROUTER, factory: UNISWAP_V2_FACTORY, coordinator: VRF_COORDINATOR, link: LINK_TOKEN, usdc: USDC, dai: DAI };
    const code = await Promise.all(Object.entries(dependencies).map(async ([name, address]) => {
        const bytecode = await client.getBytecode({ address, blockNumber: block.number });
        if (!bytecode || bytecode === "0x") throw new Error(`${name} has no code`);
        return { name, address, bytes: (bytecode.length - 2) / 2 };
    }));
    const factory = await client.readContract({ address: UNISWAP_V2_ROUTER, abi: parseAbi(["function factory() view returns (address)"]), functionName: "factory", blockNumber: block.number });
    if (factory.toLowerCase() !== UNISWAP_V2_FACTORY.toLowerCase()) throw new Error("Factory mismatch");
    for (const [address, decimals] of [[USDC, 6], [DAI, 18], [LINK_TOKEN, 18]] as const) {
        const actual = await client.readContract({ address, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals", blockNumber: block.number });
        if (actual !== decimals) throw new Error("Unexpected token decimals");
    }
    const config = await client.readContract({ address: VRF_COORDINATOR, abi: parseAbi(["function s_config() view returns (uint16,uint32,bool,uint32,uint32,uint32,uint32,uint8,uint8)"]), functionName: "s_config", blockNumber: block.number });
    if (VRF_CALLBACK_GAS_LIMIT > config[1] || VRF_CONFIRMATIONS < config[0]) throw new Error("Invalid VRF configuration");
    const lanes = await Promise.all([VRF_KEY_HASH_2_GWEI, VRF_KEY_HASH_30_GWEI, VRF_KEY_HASH_150_GWEI].map(async key => {
        const lane = await client.readContract({ address: VRF_COORDINATOR, abi: parseAbi(["function s_provingKeys(bytes32) view returns (bool,uint64)"]), functionName: "s_provingKeys", args: [key], blockNumber: block.number });
        if (!lane[0]) throw new Error(`Unregistered VRF lane ${key}`);
        return { key, maxGas: lane[1].toString() };
    }));
    const report = { checkedAt: new Date().toISOString(), chainId: 42161, blockNumber: block.number.toString(), blockHash: block.hash, code, factory, lanes, callbackGasLimit: VRF_CALLBACK_GAS_LIMIT, confirmations: VRF_CONFIRMATIONS };
    writeFileSync("deployments/arbitrum-one-dependency-check.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error("Dependency checks failed; no transaction was sent"); process.exitCode = 1; });
