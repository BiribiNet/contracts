import { viem } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

async function main() {
    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));
    const engine = await viem.getContractAt("RouletteEngine", deploy.addresses.roulette);
    const scheduler = await viem.getContractAt("UpkeepScheduler", deploy.addresses.scheduler);

    const onChainScheduler = await engine.read.UPKEEP_SCHEDULER();
    const engineOnScheduler = await scheduler.read.ENGINE();

    const checks = {
        engine: deploy.addresses.roulette,
        scheduler: deploy.addresses.scheduler,
        engine_UPKEEP_SCHEDULER: onChainScheduler,
        scheduler_ENGINE: engineOnScheduler,
        payoutLanes: await engine.read.payoutParallelLaneCount(),
        roundDuration: await engine.read.ROUND_DURATION(),
        registry: await engine.read.REGISTRY(),
        jackpotTreasury: await engine.read.JACKPOT_TREASURY(),
        jackpotFunder: await engine.read.JACKPOT_FUNDER(),
    };

    const ok =
        onChainScheduler.toLowerCase() === deploy.addresses.scheduler.toLowerCase() &&
        engineOnScheduler.toLowerCase() === deploy.addresses.roulette.toLowerCase() &&
        checks.registry.toLowerCase() === deploy.addresses.registry.toLowerCase() &&
        checks.jackpotTreasury.toLowerCase() === deploy.addresses.jackpotTreasury.toLowerCase() &&
        checks.jackpotFunder.toLowerCase() === deploy.addresses.jackpotFunder.toLowerCase();

    console.log(JSON.stringify(checks, null, 2));
    console.log(ok ? "✓ On-chain wiring matches deployment manifest" : "✗ Mismatch — review output");
    if (!ok) process.exitCode = 1;
}

main();
