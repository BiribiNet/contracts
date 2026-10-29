import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts } from "hardhat";
import { getAddress, keccak256, parseAbi, parseUnits } from "viem";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";

async function main() {
    const directory = join(__dirname, "../reports/upgrades/dai-usdc-route-mainnet-20261029");
    const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(__dirname, "../deployments/arbitrum-one.json"), "utf8"));
    const pc = createArbitrumFallbackPublicClient();
    assert.equal(await pc.getChainId(), 42161);
    const block = await pc.getBlock();
    const abi = (await artifacts.readArtifact("RoutedBRBJackpotFunder")).abi;
    const engineAbi = (await artifacts.readArtifact("RouletteEngine")).abi;
    const tokenAbi = parseAbi(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"]);
    const poolAbi = parseAbi(["function getReserves() view returns(uint112,uint112,uint32)", "function token0() view returns(address)"]);
    const routerAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns(uint256[])"]);
    const read = (address: any, contractAbi: any, functionName: string, args: unknown[] = []) => pc.readContract({
        address, abi: contractAbi, functionName, args, blockNumber: block.number }) as Promise<any>;
    assert.equal(keccak256((await pc.getBytecode({ address: plan.newFunder, blockNumber: block.number }))!), plan.sourceRuntimeHash);
    const active = await read(plan.engine, engineAbi, "JACKPOT_FUNDER");
    assert.equal(getAddress(active), getAddress(plan.newFunder));
    const implementation = await pc.getStorageAt({ address: plan.engine,
        slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", blockNumber: block.number });
    assert.equal(implementation?.toLowerCase(), plan.engineImplementation.toLowerCase());
    const immutables: Record<string, string> = {};
    for (const [name, index] of [["engine", 0], ["brbToken", 1], ["router", 2], ["jackpotTreasury", 3],
        ["sideBet", 4], ["routedAsset", 6], ["bridgeAsset", 7]] as const) {
        immutables[name] = await read(plan.newFunder, abi, name);
        assert.equal(getAddress(immutables[name]), getAddress(plan.constructorArguments[index]));
    }
    const policies: Record<string, string> = {};
    for (const [name, value] of Object.entries(plan.settings)) {
        policies[name] = String(await read(plan.newFunder, abi, name));
        assert.equal(policies[name], String(value));
    }
    assert.equal(await read(plan.engine, engineAbi, "INFRA_BPS"), 200n);
    assert.equal(getAddress(await read(plan.engine, engineAbi, "INFRA_RECIPIENT")), getAddress(manifest.infraWallet));
    const queues = [];
    for (const market of Object.values(manifest.markets) as any[]) {
        const account = await read(plan.newFunder, abi, "fundingAccounts", [market.marketId]);
        const debt = await read(plan.newFunder, abi, "pendingBrbByMarket", [market.marketId]);
        assert.equal(account[2], account[1] + account[3]);
        assert.equal(account[4], account[5] + account[6] + debt[0] + debt[1]);
        const balance = await read(market.asset, tokenAbi, "balanceOf", [plan.newFunder]);
        const reserved = await read(plan.newFunder, abi, "queuedAssetTotals", [market.asset]);
        assert(balance >= reserved);
        assert.equal(await read(market.asset, tokenAbi, "allowance", [plan.newFunder, immutables.router]), 0n);
        queues.push({ marketId: market.marketId, account, pendingTreasury: debt[0], pendingBurn: debt[1], balance,
            failures: await read(plan.newFunder, abi, "consecutiveFailures", [market.marketId]) });
    }
    const oldDai = await read(plan.oldFunder, abi, "fundingAccounts", [3]);
    assert.equal(oldDai[1], parseUnits("0.03", 18));
    assert.equal(await read(immutables.routedAsset, tokenAbi, "balanceOf", [plan.oldFunder]), oldDai[1]);
    const route = await read(plan.newFunder, abi, "fundingPath", [immutables.routedAsset]);
    assert.deepEqual(route.map(getAddress), [immutables.routedAsset, immutables.bridgeAsset, immutables.brbToken].map(getAddress));
    const pools = [];
    for (const address of ["0x8edd9aEABdf2e63f76f4c4B7F36AEFa14D3cC6BC", "0x848A51FaD11746bca839DF587C3Cde450bDfb853"]) {
        const reserves = await read(address, poolAbi, "getReserves"); assert(reserves[0] > 0n && reserves[1] > 0n);
        const observation = await read(plan.newFunder, abi, "pairObservations", [address]);
        assert(block.timestamp - BigInt(observation[0]) >= BigInt(plan.settings.twapWindowSeconds));
        pools.push({ address, reserves, observation });
    }
    const quote = await read(immutables.router, routerAbi, "getAmountsOut", [parseUnits("0.03", 18), route]);
    assert(quote.at(-1) > 0n);
    const report = { status: "passed", checkedAt: new Date().toISOString(), block: block.number, activeFunder: active,
        runtimeHash: plan.sourceRuntimeHash, engineImplementationUnchanged: true, immutables, policies,
        infrastructureBps: "200", infrastructureRecipient: manifest.infraWallet, route, quoteFor003Dai: quote,
        pools, queues, oldAcceptedDaiResidual: oldDai, allLedgersBalanced: true, routerApprovalsCleared: true };
    writeFileSync(join(directory, "live-verification.json"), JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
    console.log(JSON.stringify({ status: report.status, activeFunder: active, engineImplementationUnchanged: true,
        infrastructureBps: report.infrastructureBps, allLedgersBalanced: true, routerApprovalsCleared: true }));
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/https?:\S+/g, "[URL]") : "Live verification failed"); process.exitCode = 1; });
