/**
 * Aligns on-chain payout sharding with the number of deployed CRE payout-lane workflows.
 *
 * Payout winners are sharded by `index % payoutParallelLaneCount`; a shard without a
 * CRE workflow polling its lane would never be paid, so the on-chain count MUST equal
 * the number of registered lane workflows.
 *
 * Usage:
 *   LANE_COUNT=2 npx hardhat run scripts/setPayoutLaneCount.ts --network arbitrumsepolia
 */
import { viem } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

async function main() {
    const laneCount = Number(process.env.LANE_COUNT?.trim());
    if (!Number.isInteger(laneCount) || laneCount < 1) {
        throw new Error("Set LANE_COUNT to a positive integer (number of deployed CRE payout-lane workflows)");
    }

    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));
    const engine = await viem.getContractAt("RouletteEngine", deploy.addresses.roulette);

    const before = await engine.read.payoutParallelLaneCount();
    console.log(`payoutParallelLaneCount: ${before} -> ${laneCount}`);
    if (Number(before) === laneCount) {
        console.log("Already set; nothing to do.");
        return;
    }

    const publicClient = await viem.getPublicClient();
    const hash = await engine.write.setPayoutLaneCount([laneCount]);
    await publicClient.waitForTransactionReceipt({ hash });

    const after = await engine.read.payoutParallelLaneCount();
    console.log(`Confirmed on-chain payoutParallelLaneCount = ${after} (tx ${hash})`);
    if (Number(after) !== laneCount) {
        throw new Error("Post-check failed: on-chain lane count does not match requested value");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
