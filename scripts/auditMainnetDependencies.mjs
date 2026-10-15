// Public, read-only RPC. No wallet, dotenv, Hardhat variables or private keys.
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import { arbitrum } from "viem/chains";
import { writeFileSync } from "node:fs";
const client = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc", { timeout: 20000, retryCount: 0 }) });
if (await client.getChainId() !== 42161) throw new Error("Wrong RPC chain");
const block = await client.getBlock();
const configuredAddresses = {
    coordinator: "0x3C0Ca683b403E37668AE3DC4FB62F4B29B6f7a3e",
    forwarder: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
    link: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    usdc: "0xaf88d065e77c8cC2239327C2EDb1aB17869eD1BE",
    dai: "0xDA10009cBd5D07dd0Cecc66161FC93D7c9000da1",
    officialUsdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};
// Normalize copied mixed-case defaults for viem; retain originals for review.
const addresses = Object.fromEntries(Object.entries(configuredAddresses).map(([name, address]) => [name, address.toLowerCase()]));
const rows = await Promise.all(Object.entries(addresses).map(async ([name, address]) => {
    const code = await client.getBytecode({ address, blockNumber: block.number });
    return { name, address, codeBytes: code ? (code.length - 2) / 2 : 0, codeHash: code ? keccak256(code) : null };
}));
const tokens = await Promise.all(["usdc", "dai", "link", "officialUsdc"].map(async name => {
    if (!rows.find(row => row.name === name)?.codeBytes) return { name, valid: false, reason: "No contract code at configured address" };
    return { name, decimals: await client.readContract({
    address: addresses[name], abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals", blockNumber: block.number,
}) };
}));
const config = await client.readContract({ address: addresses.coordinator, blockNumber: block.number,
    abi: parseAbi(["function s_config() view returns (uint16,uint32,bool,uint32,uint32,uint32,uint32,uint8,uint8)"]), functionName: "s_config" });
const report = { chainId: 42161, blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString(),
    scope: "External dependency code/config only; no protocol mainnet manifest, subscription or pools verified", rows, tokens,
    vrf: { minimumConfirmations: config[0], maximumCallbackGas: config[1] } };
writeFileSync("deployments/mainnet-dependencies-2026-10-15.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
