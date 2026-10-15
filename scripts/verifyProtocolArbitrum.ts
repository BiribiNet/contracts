import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { viem } from "hardhat";
import { vars } from "hardhat/config";
import { VERIFY_DELAY_MS, MIN_BET_USDC, MIN_BET_DAI, MIN_BET_BRB, UPKEEP_SCAN_LIMIT, UPKEEP_MAX_PAYOUTS_PER_CALL, VRF_CONFIRMATIONS } from "./constants/arbitrumOne";
import { encodeBankVaultProxyInitDataFromAsset, verifyProtocolProxies } from "./utils/proxyVerification";
import { buildRouletteEngineLibraryMap, verifyContractWithDelay, verifyRouletteLinkedLibraries } from "./utils/verifyWithEtherscan";

async function main() {
    if (!vars.has("ETHERSCAN_API_KEY")) throw new Error("Explorer verification requires its separate ETHERSCAN_API_KEY credential");
    const deployJsonPath = join(__dirname, "..", "deployments", "arbitrum-one.json");
    const deploymentManifest = JSON.parse(readFileSync(deployJsonPath, "utf8"));
    const publicClient = await viem.getPublicClient();
    if (await publicClient.getChainId() !== 42161 || deploymentManifest.chainId !== 42161) throw new Error("Expected Arbitrum One");
    const a = deploymentManifest.addresses;
    const bootstrapAdmin = deploymentManifest.deployer, protocolAdmin = deploymentManifest.protocolAdmin;
    const brb = a.brb, brbReferral = a.brbReferal, router = a.uniswapRouter;
    const tipJar = { address: a.tipJar }, jackpotTreasury = { address: a.jackpotTreasury };
    const funder = { address: a.jackpotFunder }, registry = { address: a.registry };
    const engine = { address: a.engine }, sideBet = { address: a.sideBet }, scheduler = { address: a.scheduler };
    const vaultImpl = { address: a.vaultImpl }, beacon = { address: a.vaultBeacon };
    const engineImplementation = { address: a.engineImplementation }, sideBetImplementation = { address: a.sideBetImplementation };
    const challengeEvaluator = a.challengeEvaluator, linkedLibraries = deploymentManifest.linkedLibraries;
    const keeperAutomation = { creExecutionAuthority: a.creExecutionAuthority };
    const engineProxyInitData = deploymentManifest.proxyInitialization.engine;
    const sideBetProxyInitData = deploymentManifest.proxyInitialization.sideBet;
    const usdc = deploymentManifest.markets.usdc.asset, dai = deploymentManifest.markets.dai.asset;
    const marketUsdc = deploymentManifest.markets.usdc, marketDai = deploymentManifest.markets.dai, marketBrb = deploymentManifest.markets.brb;
    const vrfCoordinator = deploymentManifest.vrf.coordinator;
    const vrfKeyHashes = [deploymentManifest.vrf.keyHash2Gwei, deploymentManifest.vrf.keyHash30Gwei, deploymentManifest.vrf.keyHash150Gwei];
    const confirmations = VRF_CONFIRMATIONS, scanLimit = UPKEEP_SCAN_LIMIT, maxPayouts = UPKEEP_MAX_PAYOUTS_PER_CALL;
    const minStable = MIN_BET_USDC, minDai = MIN_BET_DAI, minBrb = MIN_BET_BRB;
    {
        const verifyDelayMs = VERIFY_DELAY_MS;
        await verifyContractWithDelay(brb, [bootstrapAdmin], verifyDelayMs);
        await verifyContractWithDelay(tipJar.address, [brb, engine.address], verifyDelayMs);
        await verifyContractWithDelay(jackpotTreasury.address, [brb, engine.address, bootstrapAdmin], verifyDelayMs);
        await verifyContractWithDelay(
            funder.address,
            [engine.address, brb, router, jackpotTreasury.address, sideBet.address, bootstrapAdmin],
            verifyDelayMs,
        );
        await verifyContractWithDelay(registry.address, [bootstrapAdmin, engine.address, sideBet.address], verifyDelayMs);
        await verifyContractWithDelay(challengeEvaluator, [], verifyDelayMs);
        await verifyContractWithDelay(vaultImpl.address, [], verifyDelayMs);
        await verifyContractWithDelay(beacon.address, [vaultImpl.address, protocolAdmin], verifyDelayMs);
        await verifyContractWithDelay(brbReferral, [engine.address], verifyDelayMs);
        await verifyRouletteLinkedLibraries(linkedLibraries, verifyDelayMs);

        const [usdcVaultInit, daiVaultInit, brbVaultInit] = await Promise.all([
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: usdc,
                marketId: 1,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minStable,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: dai,
                marketId: 2,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minDai,
                sideBetController: sideBet.address,
            }),
            encodeBankVaultProxyInitDataFromAsset(publicClient, {
                asset: brb,
                marketId: 3,
                engine: engine.address,
                bankAdmin: protocolAdmin,
                minBet: minBrb,
                sideBetController: sideBet.address,
            }),
        ]);

        await verifyProtocolProxies({
            strict: true,
            delayMs: verifyDelayMs,
            engineProxy: engine.address,
            engineImplementation: engineImplementation.address,
            engineInitData: engineProxyInitData,
            engineImplCtorArgs: [
                vrfCoordinator,
                vrfKeyHashes[0],
                vrfKeyHashes[1],
                vrfKeyHashes[2],
                confirmations,
                brbReferral,
            ],
            engineLibraryMap: buildRouletteEngineLibraryMap(linkedLibraries),
            sideBetProxy: sideBet.address,
            sideBetImplementation: sideBetImplementation.address,
            sideBetInitData: sideBetProxyInitData,
            vaultBeacon: beacon.address,
            bankVaults: [
                { bank: marketUsdc.bank, initData: usdcVaultInit },
                { bank: marketDai.bank, initData: daiVaultInit },
                { bank: marketBrb.bank, initData: brbVaultInit },
            ],
        });

        await verifyContractWithDelay(
            scheduler.address,
            [engine.address, sideBet.address, bootstrapAdmin, scanLimit, maxPayouts],
            verifyDelayMs,
        );
        await verifyContractWithDelay(keeperAutomation.creExecutionAuthority, [bootstrapAdmin], verifyDelayMs);
        deploymentManifest.verificationComplete = true;
        writeFileSync(deployJsonPath, `${JSON.stringify(deploymentManifest, null, 2)}\n`);
    }

}
main().catch(() => { console.error("Verification failed; verificationComplete remains false"); process.exitCode = 1; });
