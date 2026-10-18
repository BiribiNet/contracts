import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARBITRUM_RPC_URL, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKER_NAME, KEEPER_MAX_DRAIN_ITERATIONS, MIN_KEEPER_ETH, PAYOUT_LANE_COUNT, assertGenesisWalletsConfigured } from "./constants/arbitrumOne";

/**
 * Deploys a dedicated, autonomous keeper Worker with a single durable transaction signer.
 * Public configuration is bundled from the actual deployment manifest; no address/RPC env vars.
 * Wrangler uses its saved OAuth login. The dedicated signing key and optional
 * Goldsky wake-up credentials are supplied as Worker secrets.
 * Nothing is uploaded until the manifest, bytecode, signer and on-chain authority graph pass.
 */
async function main() {
    const { keeperWallet } = assertGenesisWalletsConfigured();
    const contractsRoot = join(__dirname, "..");
    const manifestPath = join(contractsRoot, "deployments", "arbitrum-one.json");
    if (!existsSync(manifestPath)) throw new Error("No Arbitrum One manifest: deploy the reviewed protocol before the live keeper");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.chainId !== 42161 || !manifest.handoffComplete || manifest.automation?.mode !== "cloudflare-keeper") {
        throw new Error("Manifest must describe a configured Arbitrum One keeper deployment with completed role wiring");
    }
    if (!vars.has("KEEPER_PRIVATE_KEY")) throw new Error("Set the dedicated keeper signing account with hardhat vars set KEEPER_PRIVATE_KEY");
    const privateKey = vars.get("KEEPER_PRIVATE_KEY") as Hex;
    const signer = privateKeyToAccount(privateKey);
    if (signer.address.toLowerCase() !== keeperWallet.toLowerCase() ||
        signer.address.toLowerCase() !== manifest.automation.keeper.toLowerCase()) throw new Error("Keeper signing account does not match the fixed catalog and manifest");
    if (signer.address.toLowerCase() === manifest.protocolAdmin.toLowerCase()) throw new Error("Never upload the protocol administrator's private key to the Worker");

    const addresses = {
        engine: manifest.addresses.engine, scheduler: manifest.addresses.scheduler,
        funder: manifest.addresses.jackpotFunder, authority: manifest.addresses.creExecutionAuthority,
    } as Record<"engine" | "scheduler" | "funder" | "authority", Address>;
    const client = await viem.getPublicClient();
    if (await client.getChainId() !== 42161) throw new Error("Expected Arbitrum One");
    for (const [name, address] of Object.entries(addresses)) {
        if (!isAddress(address) || BigInt(address) === 0n) throw new Error(`Invalid ${name} address in manifest`);
        const code = await client.getBytecode({ address });
        if (!code || code === "0x") throw new Error(`${name} has no deployed code`);
    }
    const readAddress = (address: Address, getter: string) => client.readContract({
        address, abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter,
    }) as Promise<Address>;
    const [authority, schedulerEngine, engineScheduler, engineFunder, laneCount, approved] = await Promise.all([
        readAddress(addresses.scheduler, "forwarderAuthority"), readAddress(addresses.scheduler, "ENGINE"),
        readAddress(addresses.engine, "UPKEEP_SCHEDULER"), readAddress(addresses.engine, "JACKPOT_FUNDER"),
        client.readContract({ address: addresses.engine, abi: parseAbi(["function payoutParallelLaneCount() view returns (uint32)"]), functionName: "payoutParallelLaneCount" }),
        client.readContract({ address: addresses.authority, abi: parseAbi(["function isApprovedAutomationForwarder(address) view returns (bool)"]), functionName: "isApprovedAutomationForwarder", args: [signer.address] }),
    ]);
    if (authority.toLowerCase() !== addresses.authority.toLowerCase() || schedulerEngine.toLowerCase() !== addresses.engine.toLowerCase() ||
        engineScheduler.toLowerCase() !== addresses.scheduler.toLowerCase() || engineFunder.toLowerCase() !== addresses.funder.toLowerCase() ||
        !approved || laneCount !== PAYOUT_LANE_COUNT) throw new Error("On-chain keeper wiring does not match the deployment manifest");
    if (await client.getBalance({ address: signer.address }) < MIN_KEEPER_ETH) throw new Error("Fund the keeper with at least 0.005 ETH before deploying its Worker");
    const marketIds = Object.values(manifest.markets as Record<string, { marketId: number }>).map(market => market.marketId);
    if (marketIds.length === 0 || marketIds.length > 10 || marketIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid funding market catalog");

    const workerRoot = join(contractsRoot, "..", "cre-automation-starter");
    const deploymentRoot = mkdtempSync(join(tmpdir(), "biribi-mainnet-worker-"));
    try {
        cpSync(join(workerRoot, "src"), join(deploymentRoot, "src"), { recursive: true });
        cpSync(join(workerRoot, "node_modules"), join(deploymentRoot, "node_modules"), { recursive: true, verbatimSymlinks: true });
        const wrangler = join(deploymentRoot, "node_modules", ".bin", "wrangler");
        const command = (args: string[], capture = false) => {
            const result = spawnSync(wrangler, args, { cwd: deploymentRoot, encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell: false });
            if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed; check login and Cloudflare account permissions`);
            return result.stdout;
        };
        const identity = JSON.parse(command(["whoami", "--json"], true));
        const accounts = identity.accounts ?? [];
        if (!accounts.some((account: { id: string }) => account.id === CLOUDFLARE_ACCOUNT_ID)) throw new Error("Wrangler login cannot access the fixed Biribi Cloudflare account");
        const config = {
            name: CLOUDFLARE_WORKER_NAME, account_id: CLOUDFLARE_ACCOUNT_ID,
            main: "src/mainnet.ts", compatibility_date: "2026-10-15", compatibility_flags: ["nodejs_compat"],
            workers_dev: true,
            durable_objects: { bindings: [{ name: "KEEPER", class_name: "MainnetKeeper" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["MainnetKeeper"] }],
            triggers: { crons: ["* * * * *"] },
            observability: { enabled: true },
        };
        const workerSettings = { chainId: 42161, rpcUrl: ARBITRUM_RPC_URL, ...addresses, keeper: signer.address,
            laneCount: PAYOUT_LANE_COUNT, marketIds, maxTransactionsPerWake: KEEPER_MAX_DRAIN_ITERATIONS };
        writeFileSync(join(deploymentRoot, "src", "mainnet-settings.ts"),
            `export const settings = ${JSON.stringify(workerSettings, null, 2)} as const;\nexport type KeeperSettings = typeof settings;\n`);
        writeFileSync(join(deploymentRoot, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
        const secretPath = join(deploymentRoot, "secrets.json");
        const workerSecrets: Record<string, string> = { KEEPER_PRIVATE_KEY: privateKey };
        const localCredentialPath = join(contractsRoot, "scripts", "constants", "arbitrumOne.local.json");
        if (existsSync(localCredentialPath)) {
            const credentials = JSON.parse(readFileSync(localCredentialPath, "utf8"));
            const countdown = credentials.countdownWebhookSecret;
            const payout = credentials.payoutWebhookSecret;
            if (countdown !== undefined || payout !== undefined) {
                if (typeof countdown !== "string" || countdown.length < 32 ||
                    typeof payout !== "string" || payout.length < 32 || countdown === payout) {
                    throw new Error("Set distinct countdownWebhookSecret and payoutWebhookSecret (at least 32 characters each)");
                }
                workerSecrets.MAINNET_COUNTDOWN_WEBHOOK_SECRET = countdown;
                workerSecrets.MAINNET_PAYOUT_WEBHOOK_SECRET = payout;
            } else if (credentials.keeperWebhookSecret !== undefined) {
                throw new Error("Migrate keeperWebhookSecret to separate countdownWebhookSecret and payoutWebhookSecret before deploying");
            }
        }
        writeFileSync(secretPath, JSON.stringify(workerSecrets), { mode: 0o600, flag: "wx" });
        // One upload includes code and its signing secret; no live interval with missing configuration.
        command(["deploy", "--config", "wrangler.json", "--dry-run"]);
        const deploymentOutput = command(["deploy", "--config", "wrangler.json", "--secrets-file", secretPath], true);
        const url = deploymentOutput.match(/https:\/\/biribi-round-watcher-arbitrum-one\.[a-z0-9-]+\.workers\.dev\b/)?.[0];
        manifest.automation.workerDeployed = true;
        manifest.automation.workerHealthVerified = false;
        const { rpcUrl: _rpcUrl, ...publicSettings } = workerSettings;
        manifest.automation.workerSettings = publicSettings;
        manifest.automation.workerDeployedAt = new Date().toISOString();
        if (url) {
            manifest.automation.workerUrl = url;
            // Starts the durable alarm and confirms actual readiness, not merely HTTP liveness.
            // Worker and Durable Object code propagate independently; preserve the
            // existing signer object while allowing the backing code to catch up.
            const readinessDeadline = Date.now() + 8 * 60_000;
            for (let attempt = 0; Date.now() < readinessDeadline; attempt++) {
                const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
                if (health?.ok) {
                    const status = await health.json() as { ok?: boolean; chainId?: number; mode?: string; webhooksEnabled?: boolean;
                        engine?: string; scheduler?: string; keeper?: string; marketIds?: number[]; laneCount?: number };
                    if (status.ok && status.chainId === 42161 && status.mode === "keeper" &&
                        status.engine?.toLowerCase() === addresses.engine.toLowerCase() &&
                        status.scheduler?.toLowerCase() === addresses.scheduler.toLowerCase() &&
                        status.keeper?.toLowerCase() === signer.address.toLowerCase() &&
                        status.laneCount === PAYOUT_LANE_COUNT && JSON.stringify(status.marketIds) === JSON.stringify(marketIds) &&
                        (!workerSecrets.MAINNET_COUNTDOWN_WEBHOOK_SECRET || status.webhooksEnabled === true)) {
                        manifest.automation.workerHealthVerified = true;
                        break;
                    }
                }
                if (attempt > 0 && attempt % 12 === 0) console.log("Waiting for Cloudflare keeper code and secret readiness");
                await new Promise(resolve => setTimeout(resolve, 5_000));
            }
        }
        manifest.automation.marketCatalogUpdatePending = !manifest.automation.workerHealthVerified;
        manifest.automation.goldskyWakeupsEnabled = Boolean(workerSecrets.MAINNET_COUNTDOWN_WEBHOOK_SECRET && manifest.automation.workerHealthVerified);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        writeFileSync(join(contractsRoot, "deployments", "arbitrum-one-worker.json"), JSON.stringify({ config, workerSettings: publicSettings }, null, 2) + "\n");
        console.log(JSON.stringify({ worker: CLOUDFLARE_WORKER_NAME, url: url ?? null,
            workerHealthVerified: manifest.automation.workerHealthVerified, settings: publicSettings }, null, 2));
        if (!manifest.automation.workerHealthVerified) throw new Error("Worker uploaded but readiness was not confirmed; inspect /health and Cloudflare logs");
    } finally {
        rmSync(deploymentRoot, { recursive: true, force: true });
    }
}
main().catch((error) => {
    const message = error instanceof Error && !/https?:\/\/|0x[a-f0-9]{64}/i.test(error.message)
        ? error.message : "Inspect Wrangler output and the manifest for the deployment result";
    console.error(`Worker deployment did not complete all checks: ${message}. No activation approval was recorded.`);
    process.exitCode = 1;
});
