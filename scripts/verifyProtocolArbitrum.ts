import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viem } from "hardhat";
import { vars } from "hardhat/config";
import { type Address } from "viem";
import { VERIFY_DELAY_MS } from "./constants/arbitrumOne";
import { encodeBankVaultProxyInitDataFromAsset } from "./utils/proxyVerification";
import { buildRouletteEngineLibraryMap } from "./utils/verifyWithEtherscan";
import { verifyExactCompilerBuild } from "./utils/verifyExactCompilerBuild";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";

type Target = Parameters<typeof verifyExactCompilerBuild>[0];
async function main() {
    if (!vars.has("ETHERSCAN_API_KEY")) throw new Error("Explorer verification requires ETHERSCAN_API_KEY");
    const path = join(__dirname, "..", "deployments", "arbitrum-one.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161 || manifest.chainId !== 42161) throw new Error("Expected Arbitrum One");
    const a = manifest.addresses;
    const admin = manifest.deployer;
    const targets: Target[] = [
        { address: a.brb, artifact: "BRBToken", constructorArguments: [admin] },
        { address: a.tipJar, artifact: "TipJar", constructorArguments: [a.brb, a.engine] },
        { address: a.jackpotTreasury, artifact: "JackpotTreasury", constructorArguments: [a.brb, a.engine, admin] },
        { address: a.jackpotFunder, artifact: "BRBJackpotFunder", constructorArguments: [a.engine, a.brb, a.uniswapRouter, a.jackpotTreasury, a.sideBet, admin] },
        { address: a.registry, artifact: "MarketRegistry", constructorArguments: [admin, a.engine, a.sideBet] },
        { address: a.challengeEvaluator, artifact: "SideBetChallengeEvaluator", buildContract: "contracts/SideBet.sol:SideBet", constructorArguments: [] },
        { address: a.vaultImpl, artifact: "BankVault4626", constructorArguments: [] },
        { address: a.vaultBeacon, artifact: "UpgradeableBeacon", constructorArguments: [a.vaultImpl, manifest.protocolAdmin] },
        { address: a.brbReferal, artifact: "BRBReferal", constructorArguments: [a.engine] },
    ];
    const libraries = manifest.linkedLibraries;
    for (const [key, artifact, links] of [
        ["rouletteLib", "RouletteLib", {}], ["rouletteBetLib", "RouletteBetLib", {}],
        ["jackpotBatchLib", "JackpotBatchLib", {}], ["roulettePayoutMulLib", "RoulettePayoutMulLib", {}],
        ["rouletteExposureLib", "RouletteExposureLib", {}], ["rouletteJackpotCollectLib", "RouletteJackpotCollectLib", {}],
        ["rouletteLiabilityMathLib", "RouletteLiabilityMathLib", { "contracts/RouletteLib.sol:RouletteLib": libraries.rouletteLib }],
        ["rouletteBetCodecLib", "RouletteBetCodecLib", { "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": libraries.rouletteBetLib }],
        ["roulettePayoutSweepLib", "RoulettePayoutSweepLib", { "contracts/libraries/RouletteBetLib.sol:RouletteBetLib": libraries.rouletteBetLib, "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib": libraries.roulettePayoutMulLib }],
        ["rouletteUpkeepScanLib", "RouletteUpkeepScanLib", { "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": libraries.jackpotBatchLib, "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib": libraries.rouletteJackpotCollectLib, "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": libraries.roulettePayoutSweepLib }],
    ] as Array<[string, string, Record<string, string>]>) targets.push({ address: libraries[key], artifact, libraries: links, constructorArguments: [] });
    targets.push(
        { address: a.sideBetImplementation, artifact: "SideBet", constructorArguments: [] },
        { address: a.engineImplementation, artifact: "RouletteEngine", constructorArguments: [manifest.vrf.coordinator, manifest.vrf.keyHash2Gwei, manifest.vrf.keyHash30Gwei, manifest.vrf.keyHash150Gwei, manifest.vrf.confirmations, a.brbReferal], libraries: buildRouletteEngineLibraryMap(libraries) },
        { address: a.engine, artifact: "ERC1967Proxy", constructorArguments: [a.engineImplementation, manifest.proxyInitialization.engine] },
        { address: a.sideBet, artifact: "ERC1967Proxy", constructorArguments: [a.sideBetImplementation, manifest.proxyInitialization.sideBet] },
    );
    for (const market of Object.values(manifest.markets) as Array<{ asset: Address; bank: Address; marketId: number; minBet: string }>) {
        const init = await encodeBankVaultProxyInitDataFromAsset(client, { asset: market.asset, marketId: market.marketId,
            engine: a.engine, bankAdmin: manifest.protocolAdmin, minBet: BigInt(market.minBet), sideBetController: a.sideBet });
        targets.push({ address: market.bank, artifact: "BeaconProxy", constructorArguments: [a.vaultBeacon, init] });
    }
    targets.push(
        { address: a.scheduler, artifact: "UpkeepScheduler", constructorArguments: [a.engine, a.sideBet, admin, manifest.automation.scanLimit, manifest.automation.maxPayoutsPerCall] },
        { address: a.creExecutionAuthority, artifact: "CreExecutionAuthority", constructorArguments: [admin] },
    );
    for (const target of targets) {
        try { await verifyExactCompilerBuild(target); }
        catch { throw new Error(`Exact compiler verification failed for ${target.artifact} at ${target.address}; no completion flag recorded`); }
        await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY_MS));
    }
    const latest = JSON.parse(readFileSync(path, "utf8"));
    latest.verificationComplete = true;
    latest.sourceVerification = { checkedAt: new Date().toISOString(), contracts: targets.map(({ address, artifact, buildContract }) => ({ address, artifact, ...(buildContract ? { buildContract } : {}) })), count: targets.length };
    writeFileSync(path, JSON.stringify(latest, null, 2) + "\n");
    console.log(`All ${targets.length} deployed protocol contracts source verified.`);
}
main().catch(error => { console.error(error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message) ? error.message : "Source verification interrupted; no completion flag recorded"); process.exitCode = 1; });
