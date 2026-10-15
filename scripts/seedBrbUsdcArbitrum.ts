import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viem, network } from "hardhat";
import { parseUnits } from "viem";
import { createArbitrumFallbackPublicClient, installHardhatRpcFailover } from "./utils/hardhatRpcFailover";
import { seedMainnetBrbUsdcPool } from "./utils/seedMainnetBrbUsdcPool";

// User-confirmed amounts. No environment overrides and no LP cliff/vesting deployment.
export const INITIAL_PAIR_BRB_AMOUNT = parseUnits("2400000", 18);
export const INITIAL_PAIR_USDC_AMOUNT = parseUnits("24000", 6);
async function main() {
    installHardhatRpcFailover(network.provider);
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161) throw new Error("Expected Arbitrum One");
    const [deployer] = await viem.getWalletClients();
    const root = join(__dirname, "..", "deployments");
    const manifestPath = join(root, "arbitrum-one.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.chainId !== 42161 || !manifest.handoffComplete || manifest.deployer.toLowerCase() !== deployer.account.address.toLowerCase()) throw new Error("Deployment manifest/signing account mismatch");
    const journalPath = join(root, "arbitrum-one-liquidity-progress.json");
    const txPath = join(root, "arbitrum-one-liquidity-transactions.jsonl");
    if (existsSync(journalPath) || manifest.liquidity?.seeded) throw new Error("Liquidity already started; inspect receipts before recovery, do not rerun blindly");
    const [latest, pending] = await Promise.all([client.getTransactionCount({ address: deployer.account.address, blockTag: "latest" }), client.getTransactionCount({ address: deployer.account.address, blockTag: "pending" })]);
    if (latest !== pending) throw new Error("Deployer has pending transactions");
    writeFileSync(journalPath, JSON.stringify({ stage: "started", deployer: deployer.account.address, nonce: pending, brb: manifest.addresses.brb, brbAmount: INITIAL_PAIR_BRB_AMOUNT.toString(), usdcAmount: INITIAL_PAIR_USDC_AMOUNT.toString(), lpRecipient: deployer.account.address, lpVestingLockDeployed: false }, null, 2) + "\n", { flag: "wx" });
    const seeded = await seedMainnetBrbUsdcPool({ deployer, client, brb: manifest.addresses.brb, brbAmount: INITIAL_PAIR_BRB_AMOUNT, usdcAmount: INITIAL_PAIR_USDC_AMOUNT, waitWrite: async promise => {
        const hash = await promise;
        appendFileSync(txPath, JSON.stringify({ event: "broadcast", hash }) + "\n");
        const receipt = await client.waitForTransactionReceipt({ hash });
        appendFileSync(txPath, JSON.stringify({ event: "receipt", hash, status: receipt.status, blockNumber: receipt.blockNumber.toString() }) + "\n");
        if (receipt.status !== "success") throw new Error(`Liquidity transaction reverted: ${hash}`);
    } });
    // Reload so any independently completed worker metadata is preserved.
    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    finalManifest.liquidity = { ...finalManifest.liquidity, dexPairCreationDeferred: false, seeded: true,
        usdcUntouched: false, architectureDeploymentUsdcUntouched: true, seededAt: new Date().toISOString(),
        ...seeded, futureLiquidityBrb: { owner: deployer.account.address, amount: "0" },
        note: "BRB/USDC seeded by deployer with approved amounts. All minted LP stays with deployer; no cliff or vesting contract deployed or funded. Stablecoin betting markets remain deferred." };
    writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + "\n");
    writeFileSync(journalPath, JSON.stringify({ stage: "complete", ...seeded }, null, 2) + "\n");
    console.log(JSON.stringify(seeded, null, 2));
}
main().catch(error => { console.error(error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message) ? error.message : "Liquidity result uncertain; inspect journal and receipts before recovery. Do not rerun blindly."); process.exitCode = 1; });
