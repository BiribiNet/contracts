/**
 * Generates per-lane CRE workflow config JSON files (LOG, or BOTH when HTTP keys are set).
 *
 * Usage:
 *   SCHEDULER=0x... RECEIVER=0x... ENGINE=0x... LANE_COUNT=10 NETWORK=arbitrum-sepolia yarn generate:cre:configs
 *
 * Optional HTTP recovery wake on each lane (same workflow slot — no extra CRE registration):
 *   CRE_HTTP_AUTHORIZED_ADDRESS=0x... yarn generate:cre:configs ...
 *   CRE_HTTP_AUTHORIZED_ADDRESSES=0xA...,0xB... yarn generate:cre:configs ...
 *
 * NETWORK: `arbitrum-sepolia` | `arbitrum-one` | `ethereum-sepolia`
 */
import { isAddress, type Address } from "viem";

import {
    type CreNetworkKey,
    logCrePayoutWorkflowDeployCommands,
    writeCreLaneConfigs,
    writeCreWorkflowYaml,
} from "./utils/writeCreWorkflowConfigs";

function parseOptionalAuthorizedKeys(): Address[] | undefined {
    const multi = process.env.CRE_HTTP_AUTHORIZED_ADDRESSES?.trim();
    if (multi) {
        const keys = multi
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        for (const key of keys) {
            if (!isAddress(key)) {
                throw new Error(`Invalid address in CRE_HTTP_AUTHORIZED_ADDRESSES: ${key}`);
            }
        }
        return keys as Address[];
    }

    const single = process.env.CRE_HTTP_AUTHORIZED_ADDRESS?.trim();
    if (!single) return undefined;
    if (!isAddress(single)) {
        throw new Error("CRE_HTTP_AUTHORIZED_ADDRESS must be a valid EVM address");
    }
    return [single];
}

function main() {
    const scheduler = process.env.SCHEDULER?.trim();
    const receiver = process.env.RECEIVER?.trim();
    const engine = process.env.ENGINE?.trim();
    const network = (process.env.NETWORK?.trim() ?? "arbitrum-sepolia") as CreNetworkKey;
    const laneCount = Number(process.env.LANE_COUNT?.trim() ?? "1");
    const writeGasLimit = process.env.CRE_WRITE_GAS_LIMIT?.trim() ?? "2500000";
    const laneMaxDrainIterations = Number(process.env.CRE_LANE_MAX_DRAIN_ITERATIONS?.trim() ?? "5");
    const httpAuthorizedKeys = parseOptionalAuthorizedKeys();

    if (!scheduler || !isAddress(scheduler)) {
        throw new Error("Set SCHEDULER to the deployed UpkeepScheduler address");
    }
    if (!receiver || !isAddress(receiver)) {
        throw new Error("Set RECEIVER to the deployed AutomationReceiver address");
    }
    if (!engine || !isAddress(engine)) {
        throw new Error("Set ENGINE to the deployed RouletteEngine address");
    }

    writeCreLaneConfigs({
        network,
        scheduler,
        receiver,
        engine,
        laneCount,
        writeGasLimit,
        laneMaxDrainIterations,
        httpAuthorizedKeys,
    });
    writeCreWorkflowYaml(laneCount);

    console.log(
        httpAuthorizedKeys?.length
            ? `\nLane configs use migrationType BOTH (LOG + HTTP recovery). Update existing workflows in place (no new CRE slots).`
            : `\nLane configs use migrationType LOG only. Pass CRE_HTTP_AUTHORIZED_ADDRESS to enable HTTP recovery on each lane.`,
    );
    logCrePayoutWorkflowDeployCommands(laneCount, "production");
}

main();
