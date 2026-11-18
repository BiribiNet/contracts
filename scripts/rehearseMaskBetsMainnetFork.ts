/** Local fork rehearsal. Upstream permits reads only; no private key is loaded. */
import hre, { network, viem } from "hardhat";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { encodeMultiBet, type BetLeg } from "../test/helpers/multiBetEncode";
import { customErrorPattern } from "../test/helpers/customErrorPattern";

const C = require("./mask-bets-v1-common.cjs");
const U = require("./mask-bets-v1-mainnet.cjs");
const READS = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
    "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_getTransactionByHash",
    "eth_getTransactionReceipt", "eth_getLogs", "eth_getProof", "eth_gasPrice", "eth_feeHistory"]);
const ENDPOINTS = [...(process.env.ARBITRUM_FORK_URL ? [process.env.ARBITRUM_FORK_URL] : []),
    "https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"];
const ENGINE_ROOT = 0x8a653c570a28b92a786a8846d2fb5907e111615753e347ab6161fea696c7eb00n;
const VAULT_ROOT = 0xb0c430920bd46af8c5ecb68ebf1a5f6f3805a863a6d4fa0fa5e65feb72f8e800n;
const TOKEN_ABI = parseAbi(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
    "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const mask = (size: number): BetLeg => ({ betType: 16n, number: (1n << BigInt(size)) - 1n, amount: 0n });

async function main() {
    assert.equal(network.name, "hardhat");
    assert.equal(Number(await network.provider.send("eth_chainId")), 31337);
    assert.deepEqual(Object.keys(hre.config.networks).filter(n => n !== "localhost"), ["hardhat"]);
    const output = process.env.MASK_FORK_REPORT_DIR ? resolve(process.env.MASK_FORK_REPORT_DIR)
        : join(__dirname, "../reports/local/mask-bets-fork");
    mkdirSync(output, { recursive: true });
    const report: any = { passed: false, mode: "local-fork-only", sourceChainId: 42161, localChainId: 31337,
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: C.ROOT, encoding: "utf8" }).trim(),
        upstreamMethods: {}, upstreamRetries: 0, blockedBroadcastProbe: false,
        upgrades: [], cases: [], fixtureTokenBalanceOverrides: [], transactions: [] };
    const legCap = Number(process.env.MASK_FORK_LEG_CAP ?? 448);
    assert(Number.isInteger(legCap) && legCap >= 1 && legCap <= 65535, "Invalid fork leg cap");
    const save = (name: string, value: unknown) => writeFileSync(join(output, name), C.stringify(value));
    let latestBlockCache: { result: unknown; expires: number } | undefined;
    async function forward(request: any): Promise<any> {
        if (!READS.has(request.method)) return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Read-only fork gateway" } };
        report.upstreamMethods[request.method] = (report.upstreamMethods[request.method] ?? 0) + 1;
        if (request.method === "eth_blockNumber" && latestBlockCache && Date.now() < latestBlockCache.expires)
            return { jsonrpc: "2.0", id: request.id, result: latestBlockCache.result };
        for (let attempt = 0; attempt < 3; attempt++) {
          for (const endpoint of ENDPOINTS) {
            try {
                const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) });
                if (!res.ok) continue;
                const body: any = await res.json();
                if (body.error) continue;
                if (request.method === "eth_blockNumber") latestBlockCache = { result: body.result, expires: Date.now() + 2000 };
                return body;
            } catch { /* Try the other read-only public source. */ }
          }
          report.upstreamRetries++;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Public fork source unavailable" } };
    }
    const gateway = createServer(async (request, response) => {
        try {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const body = JSON.parse(raw);
            const result = Array.isArray(body) ? await Promise.all(body.map(forward)) : await forward(body);
            response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
        } catch { response.writeHead(400); response.end(); }
    });
    const gatewayPort = Number(process.env.MASK_FORK_GATEWAY_PORT ?? 18551);
    assert(Number.isInteger(gatewayPort) && gatewayPort >= 0 && gatewayPort <= 65535, "Invalid local gateway port");
    await new Promise<void>((resolve, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "127.0.0.1", resolve); });
    const address = gateway.address(); assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const remote = new C.ReadOnlyProvider(url, 42161, { staticNetwork: true });
    try {
        const probe: any = await (await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1,
            method: "eth_sendRawTransaction", params: ["0x"] }) })).json();
        assert.equal(probe.error.code, -32601); report.blockedBroadcastProbe = true;
        assert.equal(Number(BigInt(await remote.send("eth_chainId", []))), 42161);
        const d = C.loadMainnetDeployment();
        const sourceBlock = process.env.MASK_FORK_BLOCK ? Number(process.env.MASK_FORK_BLOCK) : await remote.getBlockNumber();
        const pinned = await remote.getBlock(sourceBlock); assert(pinned);
        report.sourceBlock = sourceBlock; report.sourceBlockHash = pinned.hash;
        const remoteBefore = { engine: await C.implementationOf(remote, d.engine),
            vault: await C.contracts(remote, d).beacon.implementation() };
        report.implementationsBefore = remoteBefore;
        await network.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: url, blockNumber: sourceBlock } }]);
        const pc = await viem.getPublicClient();
        assert.equal((await pc.getBlock({ blockNumber: BigInt(sourceBlock) })).hash, pinned.hash, "Cached fork block hash differs from source");
        const provider = hre.ethers.provider;
        const c = C.contracts(provider, d);
        const engine = await viem.getContractAt("RouletteEngine", d.engine);
        const manifest = JSON.parse(readFileSync(join(C.ROOT, "deployments/arbitrum-one.json"), "utf8"));
        const scheduler = await viem.getContractAt("UpkeepScheduler", manifest.addresses.scheduler);
        const registry = await viem.getContractAt("MarketRegistry", d.registry);
        const [, player, lp] = await viem.getWalletClients();
        const impersonate = async (who: Address) => {
            await network.provider.send("hardhat_impersonateAccount", [who]);
            await network.provider.send("hardhat_setBalance", [who, toHex(100n * 10n ** 18n)]);
        };
        const receipt = async (hash: Hex, label: string) => {
            assert.equal(await pc.getChainId(), 31337);
            const r = await pc.waitForTransactionReceipt({ hash }); assert.equal(r.status, "success", label);
            report.transactions.push({ label, hash, gasUsed: r.gasUsed }); return r;
        };
        const markets = [];
        for (const { marketId, bank } of await C.marketsOf(c, d)) {
            const config = await registry.read.getMarket([marketId]);
            markets.push({ marketId, bank: await viem.getContractAt("BankVault4626", bank), asset: config.asset,
                stake: await (await viem.getContractAt("BankVault4626", bank)).read.minBet() });
        }
        const raw = async (who: Address, root: bigint, count: number) => Promise.all(Array.from({ length: count },
            (_, i) => pc.getStorageAt({ address: who, slot: toHex(root + BigInt(i), { size: 32 }) })));
        async function snapshot() {
            const round = await engine.read.currentGlobalRound();
            const rounds = [...new Set([1n, round - 1n, round].filter(r => r > 0n))];
            return {
                config: await C.engineConfig(c), engineRaw: await raw(d.engine, ENGINE_ROOT, 64),
                engineRoles: await Promise.all([zeroHash, keccak256(toHex("ENGINE_ROUND_ROLE")), keccak256(toHex("ENGINE_PAYOUT_ROLE"))]
                    .map(role => engine.read.hasRole([role, d.admin]))),
                history: await Promise.all(rounds.map(async r => ({ round: r, global: await engine.read.globalRoundState([r]),
                    markets: await Promise.all(markets.map(m => engine.read.marketRoundStateByRound([r, m.marketId]))) }))),
                banks: await Promise.all(markets.map(async m => ({ marketId: m.marketId, raw: await raw(m.bank.address, VAULT_ROOT, 16),
                    assets: await m.bank.read.totalAssets(), supply: await m.bank.read.totalSupply(), fee: await m.bank.read.flatWithdrawFee(),
                    minBet: await m.bank.read.minBet(), locked: await m.bank.read.lockedBetLiquidity(),
                    shares: await Promise.all([d.admin, manifest.infraWallet, lp.account.address].map(who => m.bank.read.balanceOf([who]))),
                    queue: await m.bank.read.pendingWithdrawalStatus([lp.account.address]),
                    admin: await m.bank.read.hasRole([zeroHash, d.admin]) }))),
            };
        }
        async function upgrade(label: string) {
            const artifacts = C.loadArtifacts();
            const checks = await U.preflight({ provider, d, artifacts, from: d.admin });
            const before = await snapshot(); save(`${label}-before.json`, before);
            await impersonate(d.admin);
            const signer = await hre.ethers.getSigner(d.admin);
            const plan = U.buildTransactions({ d, artifacts, libraries: checks.libraries, from: d.admin, nonce: checks.nonce });
            const writes = [];
            for (const step of plan.steps) {
                const tx = await signer.sendTransaction({ to: step.to ?? undefined, data: step.data, nonce: step.nonce, gasLimit: 12_000_000n });
                const r = await tx.wait(); assert(r && r.status === 1, step.label);
                if (step.kind === "deploy") {
                    assert.equal(r.contractAddress?.toLowerCase(), step.predicted.toLowerCase());
                    await U.verifyDeployment(provider, step, artifacts, d);
                } else {
                    const trace: any = await network.provider.send("debug_traceTransaction", [tx.hash, { disableMemory: true, disableStorage: true }]);
                    const stores = trace.structLogs.filter((s: any) => s.op === "SSTORE").map((s: any) => ({ depth: s.depth,
                        slot: "0x" + s.stack.at(-1).replace(/^0x/, "").padStart(64, "0"),
                        value: "0x" + s.stack.at(-2).replace(/^0x/, "").padStart(64, "0") }));
                    assert.equal(stores.length, 1, "Upgrade may write only its implementation pointer");
                    assert.equal(stores[0].slot, step.name === "upgradeToAndCall" ? C.IMPLEMENTATION_SLOT : toHex(1n, { size: 32 }));
                    writes.push({ label: step.label, hash: tx.hash, stores });
                    if (step.name === "upgradeToAndCall") await U.verifyEngineUpgrade({ provider, d,
                        newImplementation: plan.addresses.RouletteEngine, markets: checks.markets, configBefore: checks.engineConfig });
                    else await U.verifyVaultUpgrade({ provider, d, newImplementation: plan.addresses.BankVault4626,
                        markets: checks.markets, upgradeBlock: r.blockNumber });
                }
            }
            const after = await snapshot(); save(`${label}-after.json`, after);
            assert.equal(C.stringify(after), C.stringify(before), "Existing application storage/state changed");
            report.upgrades.push({ label, storage: checks.storage, statePreserved: true, writes,
                localOnlyAddresses: plan.addresses, liveBalancesBefore: checks.balances });
            console.log(`${label}: release lock matched, storage and balances preserved, only implementation pointers written.`);
        }
        const initial = await network.provider.send("evm_snapshot");
        await upgrade("actual-state");
        for (const m of markets) await assert.rejects(pc.simulateContract({ address: m.bank.address, abi: m.bank.abi,
            functionName: "placeBet", args: [m.stake, encodeMultiBet([{ ...mask(2), amount: m.stake }]), zeroAddress],
            account: player.account.address }), customErrorPattern("MaskBetsDisabled()"));
        report.disabledMasksRejectedOnAllMarkets = true;
        assert(await network.provider.send("evm_revert", [initial]));

        // Populate OLD implementation data before upgrading: real deposit/queue and classic bets on all assets.
        // Only external ERC20 player/LP balances are overridden, never protocol storage or executable code.
        await impersonate(d.admin); await impersonate(manifest.automation.keeper); await impersonate(manifest.vrf.coordinator);
        for (const m of markets) {
            const token = { address: m.asset, abi: TOKEN_ABI };
            let slot: bigint | undefined;
            const known = await pc.readContract({ ...token, functionName: "balanceOf", args: [m.bank.address] });
            assert(known > 0n, "Need a nonzero known token balance to identify the fixture balance slot");
            for (let n = 0n; n < 100n; n++) {
                const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [m.bank.address, n]));
                if (BigInt(await pc.getStorageAt({ address: m.asset, slot: key }) ?? zeroHash) === known) { slot = n; break; }
            }
            assert(slot !== undefined, "Could not identify external token balance mapping");
            for (const who of [player, lp]) {
                const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who.account.address, slot]));
                await network.provider.send("hardhat_setStorageAt", [m.asset, key, toHex(100_000n * m.stake, { size: 32 })]);
                assert.equal(await pc.readContract({ ...token, functionName: "balanceOf", args: [who.account.address] }), 100_000n * m.stake);
                report.fixtureTokenBalanceOverrides.push({ asset: m.asset, account: who.account.address, mappingSlot: slot });
                await receipt(await who.writeContract({ ...token, functionName: "approve", args: [m.bank.address, 2n ** 256n - 1n] }), "local token approval");
            }
            const fee = await m.bank.read.flatWithdrawFee();
            await receipt(await m.bank.write.deposit([20_000n * m.stake + fee * 100n, lp.account.address], { account: lp.account }), "legacy LP deposit");
            await receipt(await m.bank.write.redeemBps([100, lp.account.address, lp.account.address], { account: lp.account }), "legacy withdrawal queued");
            await receipt(await m.bank.write.placeBet([m.stake, encodeMultiBet([{ betType: 1n, number: 7n, amount: m.stake }]), zeroAddress],
                { account: player.account, gas: 5_000_000n }), "legacy classic bet before upgrade");
            assert((await m.bank.read.pendingWithdrawalStatus([lp.account.address]))[1]);
        }
        await upgrade("populated-state");
        let gasProbe: Awaited<ReturnType<typeof viem.deployContract<"StaticCallGasProbe">>> | undefined;
        let worstCheckGas = 0n;
        report.checkUpkeepMeasurements = [];
        async function drain() {
            for (let n = 0; n < 150; n++) {
                const [needed, data] = await scheduler.read.checkUpkeep(["0x"]);
                if (!needed) return;
                if (gasProbe) {
                    const gas = await gasProbe.read.measure([scheduler.address, encodeFunctionData({
                        abi: scheduler.abi, functionName: "checkUpkeep", args: ["0x"],
                    })]);
                    if (gas > worstCheckGas) worstCheckGas = gas;
                    const [kind, lane, job] = decodeAbiParameters(parseAbiParameters(
                        "uint8 kind, uint256 lane, (uint8 kind, uint32 marketId, uint64 roundId, uint32 nextCursor, uint32 payoutShardIndex, uint32 payoutShardWidth) job"), data);
                    report.checkUpkeepMeasurements.push({ kind, lane, job, gas });
                }
                await receipt(await scheduler.write.performUpkeep([data], { account: manifest.automation.keeper, gas: 12_000_000n }), "local upkeep");
            }
            throw Error("Upkeep did not converge");
        }
        async function settle(outcome: number) {
            const round = await engine.read.currentGlobalRound();
            await network.provider.send("evm_increaseTime", [Number(await engine.read.ROUND_DURATION()) + 5]);
            await network.provider.send("evm_mine"); await drain();
            assert(await engine.read.hasPendingVrf());
            const diag = await engine.read.roundDiagnostics([round]);
            const r = await receipt(await engine.write.rawFulfillRandomWords([diag.requestId, [BigInt(outcome), BigInt((outcome + 1) % 37)]],
                { account: manifest.vrf.coordinator, gas: BigInt(await engine.read.VRF_CALLBACK_GAS_LIMIT()) }), "local VRF callback");
            await drain(); assert.equal(await engine.read.currentGlobalRound(), round + 1n);
            for (const m of markets) assert.equal(await m.bank.read.lockedBetLiquidity(), 0n);
            return { round, callbackGas: r.gasUsed };
        }
        const legacyBalances = await Promise.all(markets.map(m => pc.readContract({ address: m.asset, abi: TOKEN_ABI,
            functionName: "balanceOf", args: [player.account.address] })));
        await settle(7);
        for (let i = 0; i < markets.length; i++) {
            const m = markets[i];
            assert.equal(await pc.readContract({ address: m.asset, abi: TOKEN_ABI, functionName: "balanceOf", args: [player.account.address] }),
                legacyBalances[i] + 36n * m.stake, "Pre-upgrade bet was not paid correctly");
            assert.equal((await m.bank.read.pendingWithdrawalStatus([lp.account.address]))[1], false, "Old queue not processed");
            await receipt(await engine.write.setMaskBetLimits([m.marketId, legCap, 1000], { account: d.admin }), "local mask activation");
        }
        report.legacyBetsAndWithdrawalsSurvived = true;
        const outcomes = process.env.MASK_FORK_OUTCOMES ? process.env.MASK_FORK_OUTCOMES.split(",").map(Number)
            : Array.from({ length: 37 }, (_, i) => i);
        assert(outcomes.length > 0 && outcomes.every(n => Number.isInteger(n) && n >= 0 && n <= 36)
            && new Set(outcomes).size === outcomes.length, "MASK_FORK_OUTCOMES must contain distinct numbers in 0..36");
        let checkpoint = await network.provider.send("evm_snapshot");
        for (const outcome of outcomes) {
            assert(await network.provider.send("evm_revert", [checkpoint])); checkpoint = await network.provider.send("evm_snapshot");
            const expected = [];
            for (const m of markets) {
                const legs = [2, 24, 25, 35].map(n => ({ ...mask(n), amount: m.stake }));
                legs.push({ betType: 1n, number: 7n, amount: m.stake });
                const before = await pc.readContract({ address: m.asset, abi: TOKEN_ABI, functionName: "balanceOf", args: [player.account.address] });
                await receipt(await m.bank.write.placeBet([5n * m.stake, encodeMultiBet(legs), zeroAddress], { account: player.account, gas: 5_000_000n }), "local mixed ticket");
                const payout = [2, 24, 25, 35].reduce((sum, size) => sum + (outcome < size ? m.stake * 36n / BigInt(size) : 0n), 0n)
                    + (outcome === 7 ? 36n * m.stake : 0n);
                expected.push({ marketId: m.marketId, expectedBalance: before - 5n * m.stake + payout, payout });
            }
            const result = await settle(outcome);
            for (let i = 0; i < markets.length; i++) assert.equal(await pc.readContract({ address: markets[i].asset, abi: TOKEN_ABI,
                functionName: "balanceOf", args: [player.account.address] }), expected[i].expectedBalance, "Payout mismatch");
            report.cases.push({ outcome, ...result, markets: expected });
            console.log(`outcome ${outcome}: exact payouts and next round verified on BRB, USDC, DAI.`);
        }
        // Exercise the real scheduler to completion at the launch cap, without patching payout cursors
        // or upgrading to a test harness. The cap's expensive final chunks are reached through real payouts.
        assert(await network.provider.send("evm_revert", [checkpoint]));
        const capExpected = [];
        for (const m of markets) {
            const before = await pc.readContract({ address: m.asset, abi: TOKEN_ABI, functionName: "balanceOf", args: [player.account.address] });
            for (let done = 0; done < legCap; done += 64) {
                const count = Math.min(64, legCap - done);
                const legs = Array.from({ length: count }, () => ({ ...mask(35), amount: m.stake }));
                // Fork storage reads can take longer than the real 60-second betting window. Advance
                // placement blocks deterministically, preserving the real ROUND_DURATION setting.
                const latest: any = await network.provider.send("eth_getBlockByNumber", ["latest", false]);
                await network.provider.send("evm_setNextBlockTimestamp", [Number(BigInt(latest.timestamp)) + 1]);
                await receipt(await m.bank.write.placeBet([BigInt(count) * m.stake, encodeMultiBet(legs), zeroAddress],
                    { account: player.account, gas: 12_000_000n }), "local launch cap masks");
            }
            await assert.rejects(pc.simulateContract({ address: m.bank.address, abi: m.bank.abi, functionName: "placeBet",
                args: [m.stake, encodeMultiBet([{ ...mask(35), amount: m.stake }]), zeroAddress], account: player.account.address }),
                customErrorPattern("MaskLegCapExceeded()"));
            await assert.rejects(pc.simulateContract({ address: m.bank.address, abi: m.bank.abi, functionName: "drainWithdrawalQueue",
                args: [5n], account: player.account.address }), customErrorPattern("WithdrawalBlockedDuringResolution()"));
            capExpected.push({ marketId: m.marketId, expectedBalance: before - BigInt(legCap) * m.stake + BigInt(legCap) * (m.stake * 36n / 35n) });
            console.log(`launch cap: market ${m.marketId}, ${legCap} legs accepted and leg ${legCap + 1} rejected.`);
        }
        gasProbe = await viem.deployContract("StaticCallGasProbe");
        const capResult = await settle(0);
        for (let i = 0; i < markets.length; i++) assert.equal(await pc.readContract({ address: markets[i].asset, abi: TOKEN_ABI,
            functionName: "balanceOf", args: [player.account.address] }), capExpected[i].expectedBalance);
        report.launchCap = { legsPerMarket: legCap, markets: capExpected, ...capResult, worstCheckUpkeepInnerCallGas: worstCheckGas,
            gasTarget: 1_500_000n, withinGasTarget: worstCheckGas < 1_500_000n,
            rejectedNextLeg: true, blockedWithdrawalDrainWhileBetsLocked: true,
            placementClock: "one local EVM second per placement block; real ROUND_DURATION unchanged",
            payoutLaneCount: await engine.read.payoutParallelLaneCount(), maxPayoutsPerCall: await scheduler.read.maxPayoutsPerCall() };
        console.log(`launch cap: 3 x ${legCap} masks settled; worst checkUpkeep inner-call ${worstCheckGas} gas.`);
        const remoteAfter = { engine: await C.implementationOf(remote, d.engine), vault: await C.contracts(remote, d).beacon.implementation() };
        assert.deepEqual(remoteAfter, remoteBefore); report.mainnetImplementationsUnchanged = true;
        report.functionalChecksPassed = true;
        assert(report.launchCap.withinGasTarget, "Live scheduler launch-cap preview exceeds the 1.5M inner-call gas target");
        report.passed = true;
        console.log(`PASS: actual-state upgrade, populated-state upgrade, old bets/withdrawals and ${report.cases.length * markets.length} market outcomes.`);
    } catch (error) {
        report.error = C.redact(error);
        report.errorCauses = [];
        for (let cause: any = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
            report.errorCauses.push({ name: cause.name, message: C.redact({ message: cause.message }), details: cause.details });
        }
        console.error(C.stringify(report.errorCauses));
        throw error;
    }
    finally { save("report.json", report); remote.destroy(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
}

main().catch(error => { console.error(C.redact(error)); process.exitCode = 1; });
