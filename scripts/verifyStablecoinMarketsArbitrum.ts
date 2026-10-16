import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts, viem } from "hardhat";
import { USDC, DAI, MIN_BET_USDC, MIN_BET_DAI } from "./constants/arbitrumOne";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";
import { encodeBankVaultProxyInitDataFromAsset } from "./utils/proxyVerification";
import { verifyExactCompilerBuild } from "./utils/verifyExactCompilerBuild";

async function main() {
    const root = join(__dirname, "..", "deployments");
    const path = join(root, "arbitrum-one.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    const client = createArbitrumFallbackPublicClient();
    if (await client.getChainId() !== 42161 || m.chainId !== 42161) throw new Error("Expected Arbitrum One");
    const a = m.addresses;
    const registry = await viem.getContractAt("MarketRegistry", a.registry);
    if (await registry.read.marketCount() !== 3 || (await registry.read.getMarket([1])).asset.toLowerCase() !== a.brb.toLowerCase()) throw new Error("Unexpected market catalog");
    const artifact = await artifacts.readArtifact("BeaconProxy");
    const build = await artifacts.getBuildInfo(`${artifact.sourceName}:BeaconProxy`);
    if (!build) throw new Error("Missing BeaconProxy build");
    const runtime = build.output.contracts[artifact.sourceName].BeaconProxy.evm.deployedBytecode as { object: string; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
    let expectedCode = runtime.object.toLowerCase();
    for (const ranges of Object.values(runtime.immutableReferences ?? {})) for (const { start, length } of ranges) expectedCode = expectedCode.slice(0, start * 2) + a.vaultBeacon.slice(2).toLowerCase().padStart(length * 2, "0") + expectedCode.slice((start + length) * 2);
    const checks = [];
    for (const [name, id, asset, minBet, decimals] of [["usdc", 2, USDC, MIN_BET_USDC, 6], ["dai", 3, DAI, MIN_BET_DAI, 18]] as const) {
        const market = m.markets[name];
        if (!market || market.marketId !== id || market.asset.toLowerCase() !== asset.toLowerCase()) throw new Error("Manifest market order mismatch");
        const registered = await registry.read.getMarket([id]);
        const bank = await viem.getContractAt("BankVault4626", market.bank);
        const beaconSlot = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
        const slot = await client.getStorageAt({ address: market.bank, slot: beaconSlot });
        const code = await client.getBytecode({ address: market.bank });
        const receipt = await client.getTransactionReceipt({ hash: market.creationHash });
        const transaction = await client.getTransaction({ hash: market.creationHash });
        const correct = code?.slice(2).toLowerCase() === expectedCode && `0x${slot?.slice(-40)}`.toLowerCase() === a.vaultBeacon.toLowerCase() &&
            registered.bank.toLowerCase() === market.bank.toLowerCase() && registered.asset.toLowerCase() === asset.toLowerCase() &&
            await registry.read.assetToMarket([asset]) === id && await bank.read.marketId() === id && await bank.read.assetDecimals() === decimals &&
            (await bank.read.asset()).toLowerCase() === asset.toLowerCase() && (await bank.read.ENGINE()).toLowerCase() === a.engine.toLowerCase() &&
            (await bank.read.sideBetController()).toLowerCase() === a.sideBet.toLowerCase() && await bank.read.minBet() === minBet &&
            await bank.read.flatWithdrawFee() === minBet && await bank.read.totalAssets() === 0n && await bank.read.totalSupply() === 0n &&
            await bank.read.hasRole([await bank.read.BANK_ADMIN_ROLE(), m.protocolAdmin]) && await bank.read.hasRole([await bank.read.DEFAULT_ADMIN_ROLE(), m.protocolAdmin]) &&
            receipt.status === "success" && transaction.from.toLowerCase() === m.protocolAdmin.toLowerCase();
        if (!correct) throw new Error(`On-chain ${name} vault audit failed`);
        const init = await encodeBankVaultProxyInitDataFromAsset(client, { asset, marketId: id, engine: a.engine,
            bankAdmin: m.protocolAdmin, minBet, sideBetController: a.sideBet });
        await verifyExactCompilerBuild({ address: market.bank, artifact: "BeaconProxy", constructorArguments: [a.vaultBeacon, init] });
        checks.push({ name, marketId: id, asset, bank: market.bank, minBet: minBet.toString(), exactRuntimeMatches: true,
            beaconCorrect: true, wiringCorrect: true, adminCorrect: true, totalAssets: "0", totalShares: "0", creationHash: market.creationHash,
            sourceVerified: true, blockNumber: receipt.blockNumber.toString() });
    }
    const current = JSON.parse(readFileSync(path, "utf8"));
    const contracts = new Map((current.sourceVerification.contracts as Array<{ address: string; artifact: string }>).map(entry => [entry.address.toLowerCase(), entry]));
    for (const check of checks) contracts.set(check.bank.toLowerCase(), { address: check.bank, artifact: "BeaconProxy" });
    current.sourceVerification.contracts = [...contracts.values()];
    current.sourceVerification.count = contracts.size;
    current.sourceVerification.checkedAt = new Date().toISOString();
    current.verificationComplete = true;
    current.stablecoinMarkets.verified = true;
    current.stablecoinMarkets.verification = checks;
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    const report = { checkedAt: new Date().toISOString(), chainId: 42161, ok: true, order: ["BRB:1", "USDC:2", "DAI:3"], markets: checks };
    writeFileSync(join(root, "arbitrum-one-stablecoin-markets-audit.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error instanceof Error && !error.cause && !/https?:\/\//i.test(error.message) ? error.message : "Stablecoin verification interrupted; no on-chain transaction was sent"); process.exitCode = 1; });
