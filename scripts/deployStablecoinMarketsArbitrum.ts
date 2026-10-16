import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network, viem } from "hardhat";
import { createArbitrumFallbackPublicClient, installHardhatRpcFailover } from "./utils/hardhatRpcFailover";
import { deployStablecoinMarkets } from "./utils/deployStablecoinMarkets";

async function main() {
    installHardhatRpcFailover(network.provider);
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161) throw new Error("Expected Arbitrum One");
    const root = join(__dirname, "..", "deployments");
    const path = join(root, "arbitrum-one.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const [wallet] = await viem.getWalletClients();
    if (manifest.chainId !== 42161 || !manifest.verificationComplete || manifest.protocolAdmin.toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error("Expected verified mainnet deployment and its administrator signer");
    const progress = join(root, "arbitrum-one-stablecoin-markets-progress.json");
    const transactions = join(root, "arbitrum-one-stablecoin-markets-transactions.jsonl");
    if (existsSync(progress)) throw new Error("Stablecoin deployment already started; inspect its journal/receipts, do not rerun blindly");
    const [latest, pending] = await Promise.all([client.getTransactionCount({ address: wallet.account.address, blockTag: "latest" }), client.getTransactionCount({ address: wallet.account.address, blockTag: "pending" })]);
    if (latest !== pending) throw new Error("Administrator has pending transactions");
    writeFileSync(progress, JSON.stringify({ stage: "started", admin: wallet.account.address, nonce: pending, order: ["BRB:1 (existing)", "USDC:2", "DAI:3"] }, null, 2) + "\n", { flag: "wx" });
    const a = manifest.addresses;
    const result = await deployStablecoinMarkets({ wallet, client, registry: a.registry, engine: a.engine, sideBet: a.sideBet,
        beacon: a.vaultBeacon, brb: a.brb, admin: manifest.protocolAdmin, waitWrite: async promise => {
            const hash = await promise;
            appendFileSync(transactions, JSON.stringify({ event: "broadcast", hash }) + "\n");
            const receipt = await client.waitForTransactionReceipt({ hash });
            appendFileSync(transactions, JSON.stringify({ event: "receipt", hash, status: receipt.status, blockNumber: receipt.blockNumber.toString() }) + "\n");
            if (receipt.status !== "success") throw new Error(`Market creation reverted: ${hash}`);
        } });
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.markets = { ...current.markets, ...result.markets };
    current.addresses.banks = Object.values(current.markets).sort((x: any, y: any) => x.marketId - y.marketId).map((market: any) => market.bank);
    current.deferredMarkets = {};
    current.deploymentMode = "three-markets-brb-funded";
    current.verificationComplete = false;
    current.automation.marketCatalogUpdatePending = true;
    current.stablecoinMarkets = { deployedAt: new Date().toISOString(), order: ["BRB", "USDC", "DAI"], funded: false, ...result };
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    writeFileSync(progress, JSON.stringify({ stage: "complete", ...result }, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message) ? error.message : "Market deployment result uncertain; inspect journal and receipts before recovery. Do not rerun blindly."); process.exitCode = 1; });
