import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { encodeAbiParameters, isAddress, type Address } from "viem";

export const CRE_NETWORKS = {
    "arbitrum-sepolia": {
        chainSelectorName: "ethereum-testnet-sepolia-arbitrum-1",
    },
    "arbitrum-one": {
        chainSelectorName: "ethereum-mainnet-arbitrum-1",
    },
    "ethereum-sepolia": {
        chainSelectorName: "ethereum-testnet-sepolia",
    },
} as const;

export type CreNetworkKey = keyof typeof CRE_NETWORKS;

/** RouletteEngine events that should wake payout-lane CRE workflows. */
export const CRE_PAYOUT_LOG_EVENT_SIGNATURES = [
    "VRFResult(uint64,uint8,uint8)",
    "PayoutProgress(uint64,uint32,uint256,uint256,uint256)",
] as const;

/** Single HTTP pre-VRF workflow: TriggerVrf locks the round and requests VRF in one tx. */
export type HttpWorkflowKind = "trigger-vrf";

/** Payout LOG workflows: drain multiple markets/batches per trigger (avoids CRE round-trip per batch). */
export const DEFAULT_CRE_LANE_MAX_DRAIN_ITERATIONS = 5;

const HTTP_WORKFLOW_KINDS: Record<HttpWorkflowKind, { deployNameSuffix: string }> = {
    "trigger-vrf": { deployNameSuffix: "trigger-vrf" },
};

const WORKFLOW_DIR = join(__dirname, "..", "..", "cre", "workflows", "biribi-roulette-lane");
const WORKFLOW_YAML_PATH = join(WORKFLOW_DIR, "workflow.yaml");

/** Matches `RouletteEngine.DEFAULT_PAYOUT_LANE_COUNT`. */
export const ENGINE_DEFAULT_PAYOUT_LANE_COUNT = 10;

export function resolveCreLaneCounts(env: {
    payoutLaneCount?: string | undefined;
    upkeepLaneCount?: string | undefined;
    defaultPayoutLanes?: number;
}): { payoutLaneCount: number; creWorkflowLaneCount: number } {
    const defaultPayout = env.defaultPayoutLanes ?? ENGINE_DEFAULT_PAYOUT_LANE_COUNT;
    const payoutLaneCount = Number(env.payoutLaneCount?.trim() ?? String(defaultPayout));
    const creWorkflowLaneCount = Number(env.upkeepLaneCount?.trim() ?? String(payoutLaneCount));

    if (!Number.isInteger(payoutLaneCount) || payoutLaneCount < 1) {
        throw new Error(`PAYOUT_LANE_COUNT must be a positive integer (got ${payoutLaneCount})`);
    }
    if (!Number.isInteger(creWorkflowLaneCount) || creWorkflowLaneCount < 1) {
        throw new Error(`UPKEEP_LANE_COUNT must be a positive integer (got ${creWorkflowLaneCount})`);
    }
    if (creWorkflowLaneCount > payoutLaneCount) {
        throw new Error(
            `UPKEEP_LANE_COUNT (${creWorkflowLaneCount}) cannot exceed PAYOUT_LANE_COUNT (${payoutLaneCount})`,
        );
    }
    return { payoutLaneCount, creWorkflowLaneCount };
}

function laneWorkflowTargetYaml(
    lane: number,
    env: "test" | "production",
    opts?: { targetName?: string; workflowName?: string },
): string {
    const target = opts?.targetName ?? `lane${lane}-${env}-settings`;
    const workflowName = opts?.workflowName ?? `biribi-roulette-lane-${lane}-${env}`;
    const configPath = `./config.lane${lane}.${env}.json`;
    return `${target}:
  user-workflow:
    workflow-name: "${workflowName}"
    # Chainlink-hosted registry (login session, no mainnet gas). Default would be onchain:ethereum-mainnet.
    deployment-registry: "private"
  workflow-artifacts:
    workflow-path: "./main.ts"
    config-path: "${configPath}"
    secrets-path: ""`;
}

function httpWorkflowTargetYaml(kind: HttpWorkflowKind, env: "test" | "production"): string {
    const target = `${kind}-${env}-settings`;
    const workflowName = `biribi-${kind}-${env}`;
    const configPath = `./config.${kind}.${env}.json`;
    return `${target}:
  user-workflow:
    workflow-name: "${workflowName}"
    # Chainlink-hosted registry (login session, no mainnet gas). Default would be onchain:ethereum-mainnet.
    deployment-registry: "private"
  workflow-artifacts:
    workflow-path: "./main.ts"
    config-path: "${configPath}"
    secrets-path: ""`;
}

/** Regenerates `workflow.yaml` with one deploy target per payout lane (parallel LOG workflows). */
export function writeCreWorkflowYaml(laneCount: number): void {
    if (!Number.isInteger(laneCount) || laneCount < 1) {
        throw new Error(`laneCount must be a positive integer (got ${laneCount})`);
    }

    mkdirSync(WORKFLOW_DIR, { recursive: true });

    const sections: string[] = [
        "# Auto-generated lane targets — run deploy / yarn generate:cre:configs to refresh.",
        "# Deploy one CRE workflow per lane target below (lanes run payout shards in parallel).",
        "# HTTP pre-VRF: trigger-vrf (round-watcher) — locks the round and requests VRF in one tx.",
        "",
    ];

    for (let lane = 0; lane < laneCount; lane++) {
        sections.push(laneWorkflowTargetYaml(lane, "test"));
        sections.push("");
    }

    sections.push(
        "# Legacy alias: lane 0 test",
        laneWorkflowTargetYaml(0, "test", {
            targetName: "test-settings",
            workflowName: "biribi-roulette-lane-test",
        }),
        "",
    );

    for (let lane = 0; lane < laneCount; lane++) {
        sections.push(laneWorkflowTargetYaml(lane, "production"));
        sections.push("");
    }

    sections.push(
        "# Legacy alias: lane 0 production",
        laneWorkflowTargetYaml(0, "production", {
            targetName: "production-settings",
            workflowName: "biribi-roulette-lane-production",
        }),
        "",
    );

    for (const kind of Object.keys(HTTP_WORKFLOW_KINDS) as HttpWorkflowKind[]) {
        sections.push(httpWorkflowTargetYaml(kind, "test"));
        sections.push("");
        sections.push(httpWorkflowTargetYaml(kind, "production"));
        sections.push("");
    }

    writeFileSync(WORKFLOW_YAML_PATH, `${sections.join("\n").trimEnd()}\n`, "utf8");
    console.log(`Wrote ${WORKFLOW_YAML_PATH} (${laneCount} parallel payout lane target(s))`);
}

export function logCrePayoutWorkflowDeployCommands(laneCount: number, env: "test" | "production"): void {
    console.log(`\nDeploy ${laneCount} parallel payout LOG workflow(s) (${env}):`);
    for (let lane = 0; lane < laneCount; lane++) {
        console.log(`  cre workflow deploy biribi-roulette-lane --target=lane${lane}-${env}-settings`);
    }
}

export function laneCheckDataHex(lane: number): `0x${string}` {
    if (lane === 0) return "0x";
    return encodeAbiParameters([{ type: "uint256" }], [BigInt(lane)]);
}

export type WriteCreLaneConfigsParams = {
    network: CreNetworkKey;
    scheduler: Address;
    receiver: Address;
    engine: Address;
    laneCount: number;
    writeGasLimit?: string;
    laneMaxDrainIterations?: number;
};

export type WriteCreHttpConfigsParams = {
    network: CreNetworkKey;
    scheduler: Address;
    receiver: Address;
    writeGasLimit?: string;
    /** Round-watcher signer address(es) allowed to HTTP-trigger the pre-VRF workflow. */
    httpAuthorizedKeys?: Address[];
};

export type WriteCreWorkflowConfigsParams = WriteCreLaneConfigsParams & {
    httpAuthorizedKeys?: Address[];
};

function writeJson(path: string, data: unknown) {
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log(`Wrote ${path}`);
}

export function writeCreLaneConfigs(params: WriteCreLaneConfigsParams): void {
    const {
        network,
        scheduler,
        receiver,
        engine,
        laneCount,
        writeGasLimit = "2500000",
        laneMaxDrainIterations = DEFAULT_CRE_LANE_MAX_DRAIN_ITERATIONS,
    } = params;
    if (!(network in CRE_NETWORKS)) {
        throw new Error(`Unsupported CRE network: ${network}`);
    }
    if (!Number.isInteger(laneCount) || laneCount < 1) {
        throw new Error(`laneCount must be a positive integer (got ${laneCount})`);
    }

    const { chainSelectorName } = CRE_NETWORKS[network];
    mkdirSync(WORKFLOW_DIR, { recursive: true });

    // Arbitrum L2: SAFE fires in seconds; FINALIZED waits for L1 finality (~10–20 min) and would
    // stall payout lanes. Sequencer-feed reorg risk is negligible for this use case, so SAFE everywhere.
    const logTriggerConfidenceByEnv = {
        test: "CONFIDENCE_LEVEL_SAFE" as const,
        production: "CONFIDENCE_LEVEL_SAFE" as const,
    };

    for (let lane = 0; lane < laneCount; lane++) {
        const shared = {
            chainSelectorName,
            receiverAddress: receiver,
            targetAddress: scheduler,
            migrationType: "LOG" as const,
            logTriggerAddress: engine,
            logTriggerEventSignatures: [...CRE_PAYOUT_LOG_EVENT_SIGNATURES],
            checkData: laneCheckDataHex(lane),
            writeGasLimit,
            maxDrainIterations: laneMaxDrainIterations,
        };

        for (const env of ["test", "production"] as const) {
            writeJson(join(WORKFLOW_DIR, `config.lane${lane}.${env}.json`), {
                ...shared,
                logTriggerConfidence: logTriggerConfidenceByEnv[env],
            });
        }
    }
}

export function writeCreHttpConfigs(params: WriteCreHttpConfigsParams): void {
    const {
        network,
        scheduler,
        receiver,
        writeGasLimit = "2500000",
        httpAuthorizedKeys,
    } = params;
    const keys = (httpAuthorizedKeys ?? []).filter((key) => isAddress(key));
    if (keys.length === 0) {
        console.warn(
            "Skipping HTTP CRE workflow configs: set CRE_HTTP_AUTHORIZED_ADDRESS (or CRE_HTTP_AUTHORIZED_ADDRESSES) to the round-watcher signer EVM address(es).",
        );
        return;
    }
    if (!(network in CRE_NETWORKS)) {
        throw new Error(`Unsupported CRE network: ${network}`);
    }

    const { chainSelectorName } = CRE_NETWORKS[network];
    mkdirSync(WORKFLOW_DIR, { recursive: true });

    for (const kind of Object.keys(HTTP_WORKFLOW_KINDS) as HttpWorkflowKind[]) {
        const { deployNameSuffix } = HTTP_WORKFLOW_KINDS[kind];
        const maxDrainIterations = 1;
        const base = {
            chainSelectorName,
            receiverAddress: receiver,
            targetAddress: scheduler,
            migrationType: "HTTP" as const,
            checkData: "0x",
            writeGasLimit,
            maxDrainIterations,
            authorizedKeys: keys,
        };

        for (const env of ["test", "production"] as const) {
            writeJson(join(WORKFLOW_DIR, `config.${kind}.${env}.json`), base);
        }

        console.log(
            `Deploy HTTP workflow biribi-roulette-lane-${network}-${deployNameSuffix} with config.${kind}.production.json`,
        );
    }
}

export function writeCreWorkflowConfigs(params: WriteCreWorkflowConfigsParams): void {
    const { httpAuthorizedKeys, ...laneParams } = params;
    writeCreLaneConfigs(laneParams);
    writeCreWorkflowYaml(laneParams.laneCount);
    writeCreHttpConfigs({
        network: params.network,
        scheduler: params.scheduler,
        receiver: params.receiver,
        writeGasLimit: params.writeGasLimit,
        httpAuthorizedKeys,
    });
    logCrePayoutWorkflowDeployCommands(laneParams.laneCount, "production");
}
