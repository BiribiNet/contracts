import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Push Arbitrum Sepolia contract addresses from subgraph deployment JSON to Vercel env vars.
 *
 * Prerequisites: `vercel login` and frontend project linked (`cd frontend && vercel link`).
 *
 * Usage:
 *   DEPLOY_JSON=../subgraph/deployments/arbitrum-sepolia.json yarn sync:vercel:env
 *   DRY_RUN=1 yarn sync:vercel:env
 *
 * Env:
 *   DEPLOY_JSON — deployment manifest (default ../subgraph/deployments/arbitrum-sepolia.json)
 *   VERCEL_CWD — frontend directory (default ../frontend)
 *   VERCEL_ENV — production | preview | development (default production)
 *   GOLDSKY_SUBGRAPH_URL — optional; sets NEXT_PUBLIC_SUBGRAPH_URL when provided
 *   DRY_RUN=1 — print commands only
 */

type DeployJson = {
    addresses: {
        brb: string;
        roulette: string;
        stakedBRB: string;
        banks?: string[];
        upkeepManager?: string;
        jackpotTreasury?: string;
        jackpotFunder?: string;
        sideBet?: string;
        brbReferal?: string;
    };
    registry?: string;
    scheduler?: string;
    uniswap?: { router?: string };
    goldskySubgraphUrl?: string;
};

const contractsRoot = join(__dirname, "..");
const deployPath =
    process.env.DEPLOY_JSON?.trim() ||
    join(contractsRoot, "..", "subgraph", "deployments", "arbitrum-sepolia.json");
const vercelCwd = process.env.VERCEL_CWD?.trim() || join(contractsRoot, "..", "frontend");
const vercelEnv = (process.env.VERCEL_ENV?.trim() || "production") as "production" | "preview" | "development";
const dryRun = process.env.DRY_RUN === "1";

const deploy = JSON.parse(readFileSync(deployPath, "utf8")) as DeployJson;
const a = deploy.addresses;

function checksum(addr: string): string {
    if (!addr.startsWith("0x") || addr.length !== 42) {
        throw new Error(`Invalid address in deploy JSON: ${addr}`);
    }
    return addr;
}

const envMap: Record<string, string> = {
    NEXT_PUBLIC_CHAIN_ENV: "testnet",
    NEXT_PUBLIC_ROULETTE_ENGINE_ADDRESS: checksum(a.roulette),
    NEXT_PUBLIC_BRB_TOKEN_ADDRESS: checksum(a.brb),
    NEXT_PUBLIC_DEFAULT_BANK_ADDRESS: checksum(a.stakedBRB),
    NEXT_PUBLIC_UPKEEP_MANAGER_ADDRESS: checksum(a.upkeepManager ?? ""),
    NEXT_PUBLIC_UPKEEP_SCHEDULER_ADDRESS: checksum(deploy.scheduler ?? ""),
    NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS: checksum(deploy.registry ?? ""),
    NEXT_PUBLIC_JACKPOT_TREASURY_ADDRESS: checksum(a.jackpotTreasury ?? ""),
    NEXT_PUBLIC_JACKPOT_FUNDER_ADDRESS: checksum(a.jackpotFunder ?? ""),
    NEXT_PUBLIC_SIDE_BET_ADDRESS: checksum(a.sideBet ?? ""),
    NEXT_PUBLIC_UNISWAP_V2_ROUTER_ADDRESS: checksum(deploy.uniswap?.router ?? ""),
    NEXT_PUBLIC_VRF_COORDINATOR_ADDRESS: "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61",
    NEXT_PUBLIC_RPC_URL: "https://sepolia-rollup.arbitrum.io/rpc",
    NEXT_PUBLIC_TX_EXPLORER_URL: "https://sepolia.arbiscan.io/tx/",
};

const subgraphUrl = process.env.GOLDSKY_SUBGRAPH_URL?.trim() || deploy.goldskySubgraphUrl?.trim();
if (subgraphUrl) {
    envMap.NEXT_PUBLIC_SUBGRAPH_URL = subgraphUrl;
}

function listExisting(): Set<string> {
    const res = spawnSync("vercel", ["--cwd", vercelCwd, "env", "list", vercelEnv], {
        encoding: "utf8",
    });
    if (res.status !== 0) {
        throw new Error(`vercel env list failed: ${res.stderr || res.stdout}`);
    }
    const names = new Set<string>();
    for (const line of res.stdout.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s/);
        if (m) names.add(m[1]);
    }
    return names;
}

function upsert(name: string, value: string, existing: Set<string>) {
    if (!value) {
        console.warn(`skip ${name}: empty value in deploy JSON`);
        return;
    }
    const args =
        existing.has(name)
            ? ["env", "update", name, vercelEnv, "--value", value, "--yes"]
            : ["env", "add", name, vercelEnv, "--value", value, "--yes"];
    console.log(`${existing.has(name) ? "update" : "add"} ${name} (${vercelEnv})`);
    if (dryRun) return;
    const res = spawnSync("vercel", ["--cwd", vercelCwd, ...args], { encoding: "utf8", stdio: "pipe" });
    if (res.status !== 0) {
        throw new Error(`vercel ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
}

function main() {
    console.log(`Deploy JSON: ${deployPath}`);
    console.log(`Vercel project: ${vercelCwd} (${vercelEnv})`);
    const existing = dryRun ? new Set<string>() : listExisting();
    for (const [name, value] of Object.entries(envMap)) {
        upsert(name, value, existing);
    }
    console.log(dryRun ? "DRY_RUN=1 — no Vercel changes applied." : "Vercel env sync complete.");
}

main();
