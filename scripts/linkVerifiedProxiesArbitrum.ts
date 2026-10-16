import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vars } from "hardhat/config";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";
import { ERC1967_IMPLEMENTATION_SLOT } from "./utils/proxyVerification";

/** Explorer ABI association only; this never changes a proxy or sends an on-chain transaction. */
async function main() {
    const path = join(__dirname, "..", "deployments", "arbitrum-one.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest.verificationComplete) throw new Error("Complete source verification first");
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161) throw new Error("Expected Arbitrum One");
    const api = async (parameters: Record<string, string>, submit = false) => {
        const params = new URLSearchParams({ ...parameters, module: "contract", chainid: "42161", apikey: vars.get("ETHERSCAN_API_KEY") });
        const url = "https://api.etherscan.io/v2/api";
        const response = await fetch(submit ? url : `${url}?${params}`, {
            ...(submit ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString() } : {}),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error("Explorer API request failed");
        return await response.json() as { status: string; result: any };
    };
    const links = [];
    for (const [proxy, implementation] of [
        [manifest.addresses.engine, manifest.addresses.engineImplementation],
        [manifest.addresses.sideBet, manifest.addresses.sideBetImplementation],
        ...Object.values(manifest.markets).map((market: any) => [market.bank, manifest.addresses.vaultImpl]),
    ] as Array<[`0x${string}`, `0x${string}`]>) {
        if (!Object.values(manifest.markets).some((market: any) => market.bank.toLowerCase() === proxy.toLowerCase())) {
            const slot = await client.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT });
            if (`0x${slot?.slice(-40)}`.toLowerCase() !== implementation.toLowerCase()) throw new Error("On-chain implementation mismatch");
        }
        let source = await api({ action: "getsourcecode", address: proxy });
        let linked = source.status === "1" && source.result[0]?.Implementation?.toLowerCase() === implementation.toLowerCase();
        if (!linked) {
            let result = await api({ action: "verifyproxycontract", address: proxy, expectedimplementation: implementation }, true);
            if (result.status === "1") {
                const guid = result.result as string;
                for (let attempt = 0; attempt < 15; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 3_000));
                    result = await api({ action: "checkproxyverification", guid });
                    if (result.result !== "Pending in queue") break;
                }
            }
            source = await api({ action: "getsourcecode", address: proxy });
            linked = source.status === "1" && source.result[0]?.Implementation?.toLowerCase() === implementation.toLowerCase();
        }
        links.push({ proxy, implementation, linked });
        console.log(JSON.stringify({ proxy, implementation, linked }));
        if (!linked) throw new Error("Explorer proxy ABI association was not confirmed");
    }
    const latest = JSON.parse(readFileSync(path, "utf8"));
    latest.sourceVerification.proxyLinks = links;
    latest.sourceVerification.proxyLinksVerifiedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(latest, null, 2) + "\n");
}
main().catch(error => { console.error(error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message) ? error.message : "Explorer proxy association interrupted; no on-chain action was taken"); process.exitCode = 1; });
