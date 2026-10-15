// Public read-only check. No wallet, keys, dotenv or transactions.
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrum } from "viem/chains";
import { writeFileSync } from "node:fs";
const client = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc", { timeout: 20000, retryCount: 0 }) });
if (await client.getChainId() !== 42161) throw new Error("Wrong chain");
const block = await client.getBlock();
const usdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const abi = parseAbi(["function isBlacklisted(address account) view returns (bool)", "function blacklister() view returns (address)"]);
const [selfBlocked, blacklister] = await Promise.all([
    client.readContract({ address: usdc, abi, functionName: "isBlacklisted", args: [usdc], blockNumber: block.number }),
    client.readContract({ address: usdc, abi, functionName: "blacklister", blockNumber: block.number }),
]);
const report = { chainId: 42161, block: block.number.toString(), blockHash: block.hash, token: usdc,
    tokenAddressIsBlacklistedRecipient: selfBlocked, blacklister,
    scope: "Read-only evidence of token blacklist state; local test separately reproduces choosing an already-blocked receiver" };
writeFileSync("deployments/usdc-recipient-review-2026-10-15.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
