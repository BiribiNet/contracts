/**
 * Generates per-lane LOG-trigger CRE workflow config JSON files.
 *
 * Usage:
 *   SCHEDULER=0x... RECEIVER=0x... ENGINE=0x... LANE_COUNT=10 NETWORK=arbitrum-sepolia yarn generate:cre:configs
 *
 * NETWORK: `arbitrum-sepolia` | `arbitrum-one` | `ethereum-sepolia`
 */
import { isAddress } from "viem";

import {
    type CreNetworkKey,
    logCrePayoutWorkflowDeployCommands,
    writeCreLaneConfigs,
    writeCreWorkflowYaml,
} from "./utils/writeCreWorkflowConfigs";

function main() {
    const scheduler = process.env.SCHEDULER?.trim();
    const receiver = process.env.RECEIVER?.trim();
    const engine = process.env.ENGINE?.trim();
    const network = (process.env.NETWORK?.trim() ?? "arbitrum-sepolia") as CreNetworkKey;
    const laneCount = Number(process.env.LANE_COUNT?.trim() ?? "1");
    const writeGasLimit = process.env.CRE_WRITE_GAS_LIMIT?.trim() ?? "2500000";
    const laneMaxDrainIterations = Number(process.env.CRE_LANE_MAX_DRAIN_ITERATIONS?.trim() ?? "5");

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
    });
    writeCreWorkflowYaml(laneCount);

    console.log(
        `\nDeploy one LOG-trigger workflow per lane (parallel payout shards), workflow-name biribi-roulette-lane-{N}-production.`,
    );
    logCrePayoutWorkflowDeployCommands(laneCount, "production");
}

main();
