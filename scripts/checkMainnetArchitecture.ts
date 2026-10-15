import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { formatEther, formatUnits, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HOUSE_BOT_WALLET, INFRA_WALLET, KEEPER_WALLET, LINK_TOKEN, MARKETING_WALLET, USDC } from "./constants/arbitrumOne";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";

async function main() {
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161) throw new Error("Wrong chain");
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address;
    const balances = await Promise.all(Object.entries({ deployer, keeper: KEEPER_WALLET, infrastructure: INFRA_WALLET, marketing: MARKETING_WALLET, houseBot: HOUSE_BOT_WALLET }).map(async ([name, address]) => ({ name, address, eth: formatEther(await client.getBalance({ address })) })));
    const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const [link, usdc, gasPrice, latestNonce, pendingNonce] = await Promise.all([
        client.readContract({ address: LINK_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [deployer] }),
        client.readContract({ address: USDC, abi: tokenAbi, functionName: "balanceOf", args: [deployer] }),
        client.getGasPrice(), client.getTransactionCount({ address: deployer, blockTag: "latest" }),
        client.getTransactionCount({ address: deployer, blockTag: "pending" }),
    ]);
    const signerStatus = Object.fromEntries([["KEEPER_PRIVATE_KEY", KEEPER_WALLET], ["INFRA_PRIVATE_KEY", INFRA_WALLET], ["MARKETING_PRIVATE_KEY", MARKETING_WALLET]].map(([key, expected]) => {
        if (!vars.has(key)) return [key, { configured: false, matches: false }];
        try { return [key, { configured: true, matches: privateKeyToAccount(vars.get(key) as Hex).address.toLowerCase() === expected.toLowerCase() }]; }
        catch { return [key, { configured: true, matches: false }]; }
    }));
    const report = { checkedAt: new Date().toISOString(), chainId: 42161, balances, deployerLink: formatUnits(link, 18), deployerUsdc: formatUnits(usdc, 6), gasPriceWei: gasPrice.toString(), latestNonce, pendingNonce, signerStatus, note: "Read-only; no transaction sent" };
    mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
    writeFileSync(join(__dirname, "..", "deployments", "arbitrum-one-architecture-preflight.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error("Read-only mainnet balance/signer check failed; no transaction was sent"); process.exitCode = 1; });
