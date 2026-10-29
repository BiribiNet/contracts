/** Explorer metadata only: never signs or sends an on-chain transaction. */
import { vars } from "hardhat/config";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";

async function main() {
    const dir = join(__dirname, "../reports/upgrades/arbitrum-zero-splits-mainnet-20261029");
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    assert.equal(plan.status, "upgraded-verified");
    const pc = createArbitrumFallbackPublicClient();
    assert.equal(await pc.getChainId(), 42161);
    const slot = await pc.getStorageAt({ address: plan.proxy, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    assert.equal(slot!.slice(-40).toLowerCase(), plan.steps[4].address.slice(2).toLowerCase());
    const request = async (fields: Record<string, string>) => {
        const body = new URLSearchParams({ apikey: vars.get("ETHERSCAN_API_KEY"), chainid: "42161", module: "contract", ...fields });
        const response = await fetch("https://api.etherscan.io/v2/api?chainid=42161", { method: "POST", body, signal: AbortSignal.timeout(30_000) });
        return response.json() as Promise<any>;
    };
    let status = await request({ action: "verifyproxycontract", address: plan.proxy, expectedimplementation: plan.steps[4].address });
    if (status.status === "1") {
        const guid = status.result;
        for (let n = 0; n < 20; n++) {
            await new Promise(resolve => setTimeout(resolve, 3_000));
            status = await request({ action: "checkproxyverification", guid });
            if (status.result !== "Pending in queue") break;
        }
    }
    const current = await request({ action: "getsourcecode", address: plan.proxy });
    const implementation = current.result?.[0]?.Implementation;
    const linked = typeof implementation === "string" && implementation.toLowerCase() === plan.steps[4].address.toLowerCase();
    const report = { checkedAt: new Date().toISOString(), proxy: plan.proxy, expectedImplementation: plan.steps[4].address, explorerImplementation: implementation ?? null, linked, status: status.status, message: status.result };
    writeFileSync(join(dir, "proxy-explorer-link.json"), JSON.stringify(report, null, 2) + "\n");
    assert(linked, "Explorer proxy link has not refreshed; on-chain implementation was checked separately");
    console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "Explorer linking interrupted; no on-chain transaction was sent."); process.exitCode = 1; });
