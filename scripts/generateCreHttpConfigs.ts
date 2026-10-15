/**
 * Generates HTTP-trigger CRE workflow configs for pre-VRF automation.
 *
 * Usage:
 *   SCHEDULER=0x... RECEIVER=0x... CRE_HTTP_AUTHORIZED_ADDRESS=0x... \
 *   NETWORK=arbitrum-sepolia yarn generate:cre:http:configs
 *
 * Multiple senders:
 *   CRE_HTTP_AUTHORIZED_ADDRESSES=0xA...,0xB... yarn generate:cre:http:configs ...
 *
 * NETWORK: `arbitrum-sepolia` | `arbitrum-one` | `ethereum-sepolia`
 */
import { isAddress, type Address } from "viem";

import {
    type CreNetworkKey,
    writeCreHttpConfigs,
} from "./utils/writeCreWorkflowConfigs";

function parseAuthorizedKeys(): Address[] {
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
    if (single) {
        if (!isAddress(single)) {
            throw new Error("Set CRE_HTTP_AUTHORIZED_ADDRESS to a valid round-watcher signer EVM address");
        }
        return [single];
    }

    throw new Error(
        "Set CRE_HTTP_AUTHORIZED_ADDRESS or CRE_HTTP_AUTHORIZED_ADDRESSES to the round-watcher signer EVM address(es)",
    );
}

function main() {
    const scheduler = process.env.SCHEDULER?.trim();
    const receiver = process.env.RECEIVER?.trim();
    const network = (process.env.NETWORK?.trim() ?? "arbitrum-sepolia") as CreNetworkKey;
    const writeGasLimit = process.env.CRE_WRITE_GAS_LIMIT?.trim() ?? "2500000";
    const httpAuthorizedKeys = parseAuthorizedKeys();

    if (!scheduler || !isAddress(scheduler)) {
        throw new Error("Set SCHEDULER to the deployed UpkeepScheduler address");
    }
    if (!receiver || !isAddress(receiver)) {
        throw new Error("Set RECEIVER to the deployed AutomationReceiver address");
    }

    writeCreHttpConfigs({
        network,
        scheduler,
        receiver,
        writeGasLimit,
        httpAuthorizedKeys,
    });
}

main();
