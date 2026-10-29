/** Versioned funder deployment only. Never upgrades an engine, SideBet or vault implementation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import hre, { artifacts } from "hardhat";
import { vars } from "hardhat/config";
import { encodeDeployData, encodeFunctionData, formatEther, getContractAddress, keccak256, parseEther,
    parseUnits, toHex, zeroHash, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";
import { verifyExactCompilerBuild } from "./utils/verifyExactCompilerBuild";

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "reports/upgrades/dai-usdc-route-mainnet-20261029");
const PRIVATE = join(ROOT, "../.diagnostics/private-routed-funder-signed-20261029");
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const stringify = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const save = (name: string, v: unknown) => writeFileSync(join(DIR, name), stringify(v) + "\n");
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const sourceHash = () => createHash("sha256").update(readFileSync(join(ROOT, "contracts/RoutedBRBJackpotFunder.sol"))).digest("hex");
const same = (a: unknown, b: unknown) => assert.equal(stringify(a).toLowerCase(), stringify(b).toLowerCase());

type ConstructorArgs = [Address, Address, Address, Address, Address, Address, Address, Address];
async function payload(args: ConstructorArgs) {
    const artifact = await artifacts.readArtifact("RoutedBRBJackpotFunder");
    const info = await artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
    assert(info && info.solcLongVersion === "0.8.27+commit.40a35a09");
    for (const [path, entry] of Object.entries(info.input.sources)) {
        const disk = join(ROOT, path.startsWith("contracts/") ? path : "node_modules/" + path);
        assert.equal(readFileSync(disk, "utf8").replaceAll("\r\n", "\n"), entry.content.replaceAll("\r\n", "\n"), `Stale compiler input ${path}`);
    }
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args });
    const runtime: any = info.output.contracts[artifact.sourceName][artifact.contractName].evm.deployedBytecode;
    assert.equal(Object.keys(runtime.linkReferences).length, 0);
    let expected = runtime.object;
    const names: Record<string, string> = {};
    const walk = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (node.nodeType === "VariableDeclaration") names[node.id] = node.name;
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
    };
    Object.values(info.output.sources).forEach((s: any) => walk(s.ast));
    const values: Record<string, Address> = { engine: args[0], brb: args[1], router: args[2], jackpotTreasury: args[3],
        sideBet: args[4], routedAsset: args[6], bridgeAsset: args[7] };
    for (const [id, positions] of Object.entries(runtime.immutableReferences ?? {}) as any) {
        assert(values[names[id]], `Unexpected immutable ${names[id]}`);
        for (const { start, length } of positions) expected = expected.slice(0, start * 2)
            + values[names[id]].slice(2).toLowerCase().padStart(length * 2, "0") + expected.slice((start + length) * 2);
    }
    assert(expected.length / 2 <= 24576);
    return { data, expectedRuntime: "0x" + expected, runtimeHash: keccak256(("0x" + expected) as Hex),
        initcodeHash: keccak256(data), runtimeBytes: expected.length / 2, abi: artifact.abi };
}

async function main() {
    assert.equal(hre.network.name, "arbitrum");
    const pc = createArbitrumFallbackPublicClient();
    assert.equal(await pc.getChainId(), 42161);
    const m = JSON.parse(readFileSync(join(ROOT, "deployments/arbitrum-one.json"), "utf8"));
    const signer = m.protocolAdmin as Address;
    const engineAbi = (await artifacts.readArtifact("RouletteEngine")).abi;
    const oldAbi = (await artifacts.readArtifact("BRBJackpotFunder")).abi;
    const tokenAbi = (await artifacts.readArtifact("BRBToken")).abi;
    const readContract = (address: Address, abi: any, functionName: string, args: unknown[] = [], blockNumber?: bigint) =>
        pc.readContract({ address, abi, functionName, args, blockNumber }) as Promise<any>;
    const engine = (fn: string, args: unknown[] = []) => readContract(m.addresses.engine, engineAbi, fn, args);
    assert(await engine("hasRole", [await engine("ENGINE_FEE_ROLE"), signer]), "Missing engine fee role");
    const phase = process.env.ROUTED_FUNDER_PHASE ?? "prepare";
    mkdirSync(DIR, { recursive: true });
    if (phase === "prepare") {
        assert(!existsSync(join(DIR, "plan.json")), "A plan already exists; reconcile it rather than overwrite it");
        const rehearsal = JSON.parse(readFileSync(join(ROOT, "reports/upgrades/dai-usdc-route-draft-20261029/fork-rehearsal.json"), "utf8"));
        assert.equal(rehearsal.status, "passed");
        const oldAddress = await engine("JACKPOT_FUNDER");
        same(oldAddress, m.addresses.jackpotFunder);
        const old = (fn: string, args: unknown[] = []) => readContract(oldAddress, oldAbi, fn, args);
        const args = [m.addresses.engine, m.addresses.brb, await old("router"), await engine("JACKPOT_TREASURY"),
            m.addresses.sideBet, signer, m.markets.dai.asset, m.markets.usdc.asset] as ConstructorArgs;
        same(await old("engine"), args[0]); same(await old("brbToken"), args[1]); same(await old("sideBet"), args[4]);
        const settings = Object.fromEntries(await Promise.all(["swapAssetTotalBps", "treasuryBrbNumerator", "treasuryBrbDenominator",
            "slippageBps", "coldSlippageBps", "twapWindowSeconds", "maxSwapReserveBps"].map(async fn => [fn, await old(fn)])));
        const accounts = await Promise.all([1, 2, 3].map(async id => ({ marketId: id, account: await old("fundingAccounts", [id]),
            pending: await old("pendingBrbByMarket", [id]) })));
        for (const row of accounts) {
            assert.equal(row.account[1], row.marketId === 3 ? parseUnits("0.03", 18) : 0n, "Unexpected old residual; do not abandon additional funds");
            assert.equal(row.pending[0] + row.pending[1], 0n, "Old distribution debts require reconciliation");
        }
        assert.equal(await readContract(m.markets.dai.asset, tokenAbi, "balanceOf", [oldAddress]), parseUnits("0.03", 18));
        assert(await old("hasRole", [zeroHash, signer]));
        assert(await old("hasRole", [await old("FUNDER_ADMIN_ROLE"), signer]));
        const nonce = await pc.getTransactionCount({ address: signer, blockTag: "latest" });
        assert.equal(nonce, await pc.getTransactionCount({ address: signer, blockTag: "pending" }));
        const address = getContractAddress({ from: signer, nonce: BigInt(nonce) });
        assert(!await pc.getBytecode({ address }));
        const build = await payload(args);
        const estimate = await pc.estimateGas({ account: signer, data: build.data });
        const steps: any[] = [{ label: "deploy routed funder", nonce, address, data: build.data, gas: estimate * 13n / 10n + 100000n,
            expectedRuntime: build.expectedRuntime, runtimeHash: build.runtimeHash, runtimeBytes: build.runtimeBytes }];
        const add = (label: string, fn: string, values: unknown[]) => steps.push({ label, nonce: nonce + steps.length,
            to: address, data: encodeFunctionData({ abi: build.abi as Abi, functionName: fn, args: values }), gas: 400000n });
        for (const [getter, setter, initial] of [["swapAssetTotalBps", "setSwapAssetBps", 300n],
            ["slippageBps", "setSlippageBps", 100n], ["coldSlippageBps", "setColdSlippageBps", 300n],
            ["twapWindowSeconds", "setTwapWindowSeconds", 1800], ["maxSwapReserveBps", "setMaxSwapReserveBps", 100n]] as const) {
            if (settings[getter] !== initial) add("preserve " + getter, setter, [settings[getter]]);
        }
        if (settings.treasuryBrbNumerator !== 250n || settings.treasuryBrbDenominator !== 300n)
            add("preserve BRB split", "setTreasuryBrbSplit", [settings.treasuryBrbNumerator, settings.treasuryBrbDenominator]);
        add("seed both route observations", "updateObservation", [m.markets.dai.asset]);
        const activation = { label: "switch engine funder pointer", nonce: nonce + steps.length, to: m.addresses.engine,
            data: encodeFunctionData({ abi: engineAbi, functionName: "setJackpotFunder", args: [address] }), gas: 300000n };
        const price = await pc.getGasPrice(); assert(price <= 1000000000n);
        const maxFeePerGas = price * 3n;
        const budget = (steps.reduce((sum, row) => sum + row.gas, 0n) + activation.gas) * maxFeePerGas;
        assert(budget < parseEther("0.005")); assert(await pc.getBalance({ address: signer }) > budget);
        const implementation = await pc.getStorageAt({ address: m.addresses.engine, slot: SLOT });
        const plan = { status: "prepared", chainId: 42161, preparedAt: new Date().toISOString(), signer, sourceHash: sourceHash(),
            oldFunder: oldAddress, newFunder: address, constructorArguments: args, sourceRuntimeHash: build.runtimeHash,
            engine: m.addresses.engine, engineImplementation: implementation, settings, oldAccounts: accounts,
            acceptedOldDaiResidual: "0.03", acceptance: "Owner explicitly accepted leaving the old 0.03 DAI behind in this chat",
            maxFeePerGas, maxPriorityFeePerGas: "0", maximumGasCostEth: formatEther(budget), steps, activation };
        save("plan.json", plan); save("journal.json", { status: "prepared", transactions: [] });
        console.log(stringify({ status: plan.status, signer, oldFunder: oldAddress, newFunder: address,
            steps: steps.map(({ label, nonce, to, gas }) => ({ label, nonce, to: to ?? "contract creation", gas })),
            activation: { to: activation.to, selector: activation.data.slice(0, 10), nonce: activation.nonce },
            maximumGasCostEth: plan.maximumGasCostEth, acceptedOldDaiResidual: "0.03", engineUpgrade: false }));
        return;
    }
    const plan = read("plan.json"), journal = read("journal.json");
    assert.equal(sourceHash(), plan.sourceHash); same(signer, plan.signer);
    const build = await payload(plan.constructorArguments);
    same(build.data, plan.steps[0].data); same(build.runtimeHash, plan.sourceRuntimeHash);
    const checkCode = async () => assert.equal(keccak256((await pc.getBytecode({ address: plan.newFunder }))!), plan.sourceRuntimeHash);
    const send = async (step: any) => {
        assert.equal(process.env.ROUTED_FUNDER_AUTHORIZE_MAINNET, "42161-routed-funder-owner-approved");
        assert.equal(await pc.getChainId(), 42161);
        assert(await pc.getGasPrice() <= BigInt(plan.maxFeePerGas));
        mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
        const file = join(PRIVATE, `nonce-${step.nonce}.json`);
        let serialized: Hex;
        if (existsSync(file)) serialized = JSON.parse(readFileSync(file, "utf8")).serialized;
        else {
            assert.equal(await pc.getTransactionCount({ address: signer, blockTag: "latest" }), step.nonce, "Signer nonce drift");
            assert.equal(await pc.getTransactionCount({ address: signer, blockTag: "pending" }), step.nonce, "Unexpected pending transaction");
            const secret = vars.get("BRB_KEY");
            const account = privateKeyToAccount((secret.startsWith("0x") ? secret : "0x" + secret) as Hex);
            same(account.address, signer);
            serialized = await account.signTransaction({ type: "eip1559", chainId: 42161, nonce: step.nonce,
                to: step.to, data: step.data, value: 0n, gas: BigInt(step.gas), maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: 0n });
            writeFileSync(file, stringify({ serialized }) + "\n", { mode: 0o600, flag: "wx" });
        }
        const hash = keccak256(serialized);
        let row = journal.transactions.find((x: any) => x.nonce === step.nonce);
        if (!row) { row = { label: step.label, nonce: step.nonce, hash, status: "signed" }; journal.transactions.push(row); save("journal.json", journal); }
        assert.equal(row.hash, hash);
        let receipt;
        try { receipt = await pc.getTransactionReceipt({ hash }); } catch { /* Reconcile this same signed hash only. */ }
        if (!receipt) {
            assert(await pc.getTransactionCount({ address: signer, blockTag: "latest" }) <= step.nonce, "Consumed nonce needs reconciliation");
            row.status = "broadcasting"; save("journal.json", journal);
            try { assert.equal(await pc.sendRawTransaction({ serializedTransaction: serialized }), hash); }
            catch { throw Error(`Broadcast uncertain; reconcile ${hash} before retrying`); }
            receipt = await pc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180000 });
        }
        Object.assign(row, { status: receipt.status, block: receipt.blockNumber, gasUsed: receipt.gasUsed }); save("journal.json", journal);
        assert.equal(receipt.status, "success"); console.log(stringify({ label: step.label, hash, block: receipt.blockNumber }));
        return receipt;
    };
    if (phase === "deploy") {
        assert(plan.actualAddressForkPassed, "Exact deployment plan must pass on a local fork first");
        same(await engine("JACKPOT_FUNDER"), plan.oldFunder);
        same(await pc.getStorageAt({ address: plan.engine, slot: SLOT }), plan.engineImplementation);
        for (const step of plan.steps) { await send(step); await checkCode(); }
        const observationBlock = journal.transactions.find((x: any) => x.label === "seed both route observations").block;
        const timestamp = (await pc.getBlock({ blockNumber: BigInt(observationBlock) })).timestamp;
        plan.oraclesSeededAt = timestamp; plan.warmAt = timestamp + BigInt(plan.settings.twapWindowSeconds);
        plan.status = "deployed-oracles-seeded"; save("plan.json", plan); journal.status = plan.status; save("journal.json", journal);
        console.log(stringify({ newFunder: plan.newFunder, warmAtUtc: new Date(Number(plan.warmAt) * 1000).toISOString(), engineStillUsesOldFunder: true }));
        return;
    }
    await checkCode();
    if (phase === "verify") {
        await verifyExactCompilerBuild({ address: plan.newFunder, artifact: "RoutedBRBJackpotFunder", constructorArguments: plan.constructorArguments });
        plan.sourceVerified = true; save("plan.json", plan); return;
    }
    assert.equal(phase, "activate");
    assert(plan.sourceVerified && plan.actualAddressForkPassed, "Source verification and actual-address fork must pass before cutover");
    const reconciliation = read("indexer-reconciliation.json");
    assert.equal(reconciliation.status, "passed", "Indexer history and vault reconciliation must pass");
    assert(reconciliation.entities.length > 20 && reconciliation.entities.some((row: any) => row.count > 0), "Historical entity audit is incomplete");
    const alignedWorker = read("worker-align.json");
    assert(alignedWorker.paused && alignedWorker.bindingsPreserved, "The keeper must be aligned while paused");
    const health = await (await fetch(m.automation.workerUrl + "/health")).json() as any;
    assert(health.paused && health.pendingTransactionHash === null, "Keeper must be quiescent");
    assert((await pc.getBlock()).timestamp >= BigInt(plan.warmAt), "Oracle lookback is not warm yet");
    same(await engine("JACKPOT_FUNDER"), plan.oldFunder);
    same(await pc.getStorageAt({ address: plan.engine, slot: SLOT }), plan.engineImplementation);
    for (const [fn, value] of Object.entries(plan.settings)) same(await readContract(plan.newFunder, build.abi, fn), value);
    for (const id of [1, 2]) {
        const account = await readContract(plan.oldFunder, oldAbi, "fundingAccounts", [id]);
        const debt = await readContract(plan.oldFunder, oldAbi, "pendingBrbByMarket", [id]);
        assert.equal(account[1] + debt[0] + debt[1], 0n, "Old BRB/USDC funding remains to be drained");
    }
    const before = { implementation: await pc.getStorageAt({ address: plan.engine, slot: SLOT }),
        round: await engine("currentGlobalRound"), lanes: await engine("payoutParallelLaneCount"),
        oldDaiAccount: await readContract(plan.oldFunder, oldAbi, "fundingAccounts", [3]) };
    same(before.oldDaiAccount, plan.oldAccounts.find((x: any) => x.marketId === 3).account);
    await pc.simulateContract({ address: plan.engine, abi: engineAbi, functionName: "setJackpotFunder", args: [plan.newFunder], account: signer });
    const receipt = await send(plan.activation);
    same(await engine("JACKPOT_FUNDER"), plan.newFunder);
    same(await pc.getStorageAt({ address: plan.engine, slot: SLOT }), before.implementation);
    same(await engine("payoutParallelLaneCount"), before.lanes);
    same(await readContract(plan.oldFunder, oldAbi, "fundingAccounts", [3]), before.oldDaiAccount);
    const pointerEvents = receipt.logs.filter(log => log.address.toLowerCase() === plan.engine.toLowerCase());
    assert.equal(pointerEvents.length, 1, "Pointer change emitted unexpected engine events");
    assert.equal(pointerEvents[0].topics[0], keccak256(toHex("JackpotFunderUpdated(address,address)")));
    const storageRoot = BigInt("0x8a653c570a28b92a786a8846d2fb5907e111615753e347ab6161fea696c7eb00");
    const captured = await Promise.all([receipt.blockNumber - 1n, receipt.blockNumber].map(async blockNumber => ({ blockNumber,
        values: await Promise.all(Array.from({ length: 64 }, (_, i) => pc.getStorageAt({ address: plan.engine,
            slot: toHex(storageRoot + BigInt(i), { size: 32 }), blockNumber }))) })));
    const changedSlots = captured[0].values.flatMap((value, i) => value !== captured[1].values[i] ? [i] : []);
    same(changedSlots, [2]);
    save("activation-storage.json", { captured, changedSlots, onlyFunderPointerChanged: true });
    save("activation.json", { hash: receipt.transactionHash, block: receipt.blockNumber, engineImplementationUnchanged: true,
        payoutLanesUnchanged: true, oldDaiResidualPreserved: true, before });
    plan.status = "activated"; plan.activationHash = receipt.transactionHash; plan.activationBlock = receipt.blockNumber; save("plan.json", plan);
    journal.status = "activated"; save("journal.json", journal);
    const latest = JSON.parse(readFileSync(join(ROOT, "deployments/arbitrum-one.json"), "utf8"));
    latest.previousJackpotFunders ??= []; latest.previousJackpotFunders.push({ address: plan.oldFunder,
        startBlock: latest.startBlocks?.jackpotFunder ?? latest.startBlock, residual: { asset: m.markets.dai.asset, amount: "30000000000000000", marketId: 3, ownerAccepted: true } });
    latest.addresses.jackpotFunder = plan.newFunder;
    latest.startBlocks ??= {}; latest.startBlocks.jackpotFunder = Number(journal.transactions[0].block);
    latest.upgradeHistory ??= []; latest.upgradeHistory.push({ kind: "jackpot-funder-replacement-dai-via-usdc", date: new Date().toISOString(),
        previousFunder: plan.oldFunder, newFunder: plan.newFunder, engineImplementationChanged: false, transactionHash: receipt.transactionHash,
        report: "reports/upgrades/dai-usdc-route-mainnet-20261029/journal.json" });
    writeFileSync(join(ROOT, "deployments/arbitrum-one.json"), stringify(latest) + "\n");
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/https?:\S+/g, "[URL]").replace(/0x[a-fA-F0-9]{128,}/g, "[REDACTED]") : "Routed funder rollout failed"); process.exitCode = 1; });
