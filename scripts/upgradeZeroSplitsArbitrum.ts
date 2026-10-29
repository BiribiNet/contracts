/** Mainnet zero-split upgrade, separated into prepare / deploy / verify / upgrade phases. */
import hre, { artifacts, viem } from "hardhat";
import { vars } from "hardhat/config";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256, parseEther, formatEther, toHex, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";
import { verifyExactCompilerBuild } from "./utils/verifyExactCompilerBuild";

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "reports/upgrades/arbitrum-zero-splits-mainnet-20261029");
const PLAN = join(DIR, "plan.json");
const JOURNAL = join(DIR, "journal.json");
const PRIVATE = join(ROOT, "../.diagnostics/private-zero-split-signed-20261029");
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const FQ = (name: string) => `contracts/libraries/${name}.sol:${name}`;
const j = (value: any) => JSON.stringify(value, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const save = (path: string, value: any) => writeFileSync(path, j(value) + "\n");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const same = (a: any, b: any) => assert.equal(j(a).toLowerCase(), j(b).toLowerCase());

async function build(name: string) {
    const artifact = await artifacts.readArtifact(name);
    const info = await artifacts.getBuildInfo(`${artifact.sourceName}:${name}`);
    assert(info && info.solcLongVersion === "0.8.27+commit.40a35a09");
    for (const [path, entry] of Object.entries(info.input.sources)) {
        const disk = join(ROOT, path.startsWith("contracts/") ? path : "node_modules/" + path);
        assert.equal(readFileSync(disk, "utf8").replaceAll("\r\n", "\n"), entry.content.replaceAll("\r\n", "\n"), `Stale input ${path}`);
    }
    return { artifact, info };
}
function link(code: string, references: any, libraries: Record<string, Address>) {
    let hex = code.replace(/^0x/, "");
    for (const [source, refs] of Object.entries(references) as any) for (const [name, positions] of Object.entries(refs) as any) {
        const address = libraries[`${source}:${name}`];
        assert(address, `Missing link ${source}:${name}`);
        for (const { start, length } of positions) hex = hex.slice(0, start * 2) + address.slice(2).toLowerCase().padStart(length * 2, "0") + hex.slice((start + length) * 2);
    }
    assert(/^[a-fA-F0-9]+$/.test(hex), "Unresolved bytecode link");
    return "0x" + hex;
}
async function payload(name: string, address: Address, libraries: any, args: any[]) {
    const { artifact, info } = await build(name);
    const data = encodeDeployData({ abi: artifact.abi, bytecode: link(artifact.bytecode, artifact.linkReferences, libraries) as Hex, args });
    const runtime: any = info.output.contracts[artifact.sourceName][name].evm.deployedBytecode;
    let expected = link(runtime.object, runtime.linkReferences, libraries).slice(2);
    const names: Record<string, string> = {};
    const walk = (node: any) => { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration") names[node.id] = node.name; for (const v of Object.values(node)) if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); };
    Object.values(info.output.sources).forEach((source: any) => walk(source.ast));
    const values: any = name === "RouletteEngine" ? { _vrfCoordinator: args[0], VRF_KEY_HASH_2_GWEI: args[1], VRF_KEY_HASH_30_GWEI: args[2], VRF_KEY_HASH_150_GWEI: args[3], VRF_CONFIRMATIONS: BigInt(args[4]), BRB_REFERRAL: args[5], __self: address } : {};
    for (const [id, positions] of Object.entries(runtime.immutableReferences ?? {}) as any) {
        const value = values[names[id]];
        assert(value !== undefined, `Unknown immutable ${names[id]}`);
        const hex = (typeof value === "bigint" ? toHex(value) : value).slice(2).toLowerCase();
        for (const { start, length } of positions) expected = expected.slice(0, start * 2) + hex.padStart(length * 2, "0") + expected.slice((start + length) * 2);
    }
    if (expected.startsWith("73" + "0".repeat(40))) expected = expected.slice(0, 2) + address.slice(2).toLowerCase() + expected.slice(42);
    assert(expected.length / 2 <= 24576, "EIP-170 size limit");
    return { data, expectedRuntime: "0x" + expected, initcodeHash: keccak256(data), runtimeHash: keccak256(("0x" + expected) as Hex), runtimeBytes: expected.length / 2 };
}
async function main() {
    assert.equal(hre.network.name, "arbitrum", "Mainnet phase requires explicit --network arbitrum");
    const pc = createArbitrumFallbackPublicClient();
    assert.equal(await pc.getChainId(), 42161);
    const [wallet] = await viem.getWalletClients();
    const signer = wallet.account.address;
    const m = read(join(ROOT, "deployments/arbitrum-one.json"));
    const engine = await viem.getContractAt("RouletteEngine", m.addresses.engine);
    assert.equal(signer.toLowerCase(), m.protocolAdmin.toLowerCase(), "Unexpected mainnet signer");
    assert(await engine.read.hasRole([zeroHash, signer]), "Signer lacks upgrade authority");
    const phase = process.env.ZERO_SPLIT_PHASE ?? "prepare";
    const sourceHash = hash(readFileSync(join(ROOT, "contracts/libraries/RouletteBetLib.sol")));
    const dependencyEvidence = read(join(ROOT, "../.diagnostics/openzeppelin-dependency-check-20261029.json"));
    assert.equal(hash(readFileSync(join(ROOT, "yarn.lock"))), dependencyEvidence.lockfile.currentSha256);
    for (const [path, row] of Object.entries(dependencyEvidence.files) as any) assert.equal(hash(readFileSync(join(ROOT, "node_modules", path))), row.installedSha256);
    assert.equal(sourceHash, read(join(ROOT, "../.diagnostics/baseline-roundtrip-result-20261029.json")).fixSha256Before);
    assert.equal(execFileSync("git", ["diff", "HEAD", "--", "contracts", ":(exclude)contracts/libraries/RouletteBetLib.sol"], { cwd: ROOT, encoding: "utf8" }), "");
    const currentImplementation = async () => (`0x${(await pc.getStorageAt({ address: engine.address, slot: SLOT }))!.slice(-40)}`) as Address;
    const ctor = async (implementation: Address) => {
        const old = await viem.getContractAt("RouletteEngine", implementation);
        return [m.vrf.coordinator, await old.read.VRF_KEY_HASH_2_GWEI(), await old.read.VRF_KEY_HASH_30_GWEI(), await old.read.VRF_KEY_HASH_150_GWEI(), await old.read.VRF_CONFIRMATIONS(), await old.read.BRB_REFERRAL()];
    };
    const idle = async () => {
        const rid = await engine.read.currentGlobalRound(); const d = await engine.read.roundDiagnostics([rid]);
        return { round: rid.toString(), phase: await engine.read.roundPhase([rid]), pendingVrf: await engine.read.hasPendingVrf(), participating: d.marketsParticipating, settled: d.marketsSettled };
    };
    mkdirSync(DIR, { recursive: true });
    if (phase === "prepare") {
        assert(!existsSync(PLAN), "Plan exists: inspect it rather than overwriting");
        const previousImplementation = await currentImplementation();
        assert.equal(previousImplementation.toLowerCase(), m.addresses.engineImplementation.toLowerCase());
        const args = await ctor(previousImplementation);
        const rehearsal = read(join(ROOT, "reports/upgrades/arbitrum-zero-splits-fork-20261029/report.json"));
        assert(rehearsal.passed && rehearsal.statePreserved && rehearsal.mainnetImplementationUnchanged);
        assert(rehearsal.cases.every((c: any) => c.postPaymentRawStorageVerified && c.receiptTransfersReconciled));
        same(args, rehearsal.constructorArgs);
        const nonce = await pc.getTransactionCount({ address: signer, blockTag: "latest" });
        assert.equal(nonce, await pc.getTransactionCount({ address: signer, blockTag: "pending" }), "Pending signer transactions");
        const gasPrice = await pc.getGasPrice(); assert(gasPrice <= 1_000_000_000n, "Gas price above ceiling");
        const maxFeePerGas = gasPrice * 3n; const maxPriorityFeePerGas = 0n;
        const old = m.linkedLibraries;
        const engineLinks = (l: any) => ({ [FQ("JackpotBatchLib")]: l.jackpotBatchLib, [FQ("RouletteBetCodecLib")]: l.rouletteBetCodecLib, [FQ("RouletteLiabilityMathLib")]: l.rouletteLiabilityMathLib, [FQ("RoulettePayoutSweepLib")]: l.roulettePayoutSweepLib, [FQ("RouletteJackpotCollectLib")]: l.rouletteJackpotCollectLib, [FQ("RouletteExposureLib")]: l.rouletteExposureLib, [FQ("RouletteUpkeepScanLib")]: l.rouletteUpkeepScanLib });
        const oldRuntime = await payload("RouletteEngine", previousImplementation, engineLinks(old), args);
        assert.equal(keccak256((await pc.getBytecode({ address: previousImplementation }))!), oldRuntime.runtimeHash, "Old implementation differs from audited source/constructor");
        const definitions = ["RouletteBetLib", "RouletteBetCodecLib", "RoulettePayoutSweepLib", "RouletteUpkeepScanLib", "RouletteEngine"];
        const predicted = definitions.map((_, i) => getContractAddress({ from: signer, nonce: BigInt(nonce + i) }));
        const libraries = { ...old, rouletteBetLib: predicted[0], rouletteBetCodecLib: predicted[1], roulettePayoutSweepLib: predicted[2], rouletteUpkeepScanLib: predicted[3] };
        const links = [{}, { [FQ("RouletteBetLib")]: predicted[0] }, { [FQ("RouletteBetLib")]: predicted[0], [FQ("RoulettePayoutMulLib")]: old.roulettePayoutMulLib }, { [FQ("JackpotBatchLib")]: old.jackpotBatchLib, [FQ("RouletteJackpotCollectLib")]: old.rouletteJackpotCollectLib, [FQ("RoulettePayoutSweepLib")]: predicted[2] }, engineLinks(libraries)];
        const steps = [];
        for (let i = 0; i < definitions.length; i++) {
            assert(!await pc.getBytecode({ address: predicted[i] }), "Predicted address already has code");
            const constructorArguments = i === 4 ? args : [];
            const code = await payload(definitions[i], predicted[i], links[i], constructorArguments);
            const estimate = await pc.estimateGas({ account: signer, data: code.data });
            steps.push({ name: definitions[i], address: predicted[i], nonce: nonce + i, libraries: links[i], constructorArguments, ...code, estimatedGas: estimate, gas: estimate * 13n / 10n + 100_000n });
        }
        const upgradeData = encodeFunctionData({ abi: engine.abi, functionName: "upgradeToAndCall", args: [predicted[4], "0x"] });
        const totalGas = steps.reduce((a, s) => a + s.gas, 1_000_000n);
        const maximumGasCost = totalGas * maxFeePerGas;
        assert(maximumGasCost < parseEther("0.005"), "Gas budget exceeds 0.005 ETH");
        const balance = await pc.getBalance({ address: signer });
        assert(balance >= maximumGasCost, "Insufficient signer ETH for bounded gas budget");
        const plan = { status: "prepared", chainId: 42161, preparedAt: new Date().toISOString(), signer, proxy: engine.address, previousImplementation, previousImplementationRuntimeHash: oldRuntime.runtimeHash, constructorArguments: args, constructorArgumentsUnchanged: true, sourceHash, lockfileHash: dependencyEvidence.lockfile.currentSha256, maxFeePerGas, maxPriorityFeePerGas, maximumGasCost, maximumGasCostEth: formatEther(maximumGasCost), signerBalanceEth: formatEther(balance), startingNonce: nonce, linkedLibraries: libraries, steps, upgrade: { nonce: nonce + 5, to: engine.address, data: upgradeData, dataHash: keccak256(upgradeData), gas: 1_000_000n }, observedRound: await idle() };
        save(PLAN, plan); save(JOURNAL, { status: "prepared", transactions: [] });
        console.log(j({ phase, signer, proxy: plan.proxy, previousImplementation, constructorArguments: args, constructorArgumentsUnchanged: true, steps: steps.map(({ name, address, nonce, runtimeHash, runtimeBytes }) => ({ name, address, nonce, runtimeHash, runtimeBytes })), maximumGasCostEth: plan.maximumGasCostEth, signerBalanceEth: plan.signerBalanceEth, observedRound: plan.observedRound }));
        return;
    }
    const plan = read(PLAN); const journal = read(JOURNAL);
    assert.equal(plan.chainId, 42161); same(signer, plan.signer); assert.equal(sourceHash, plan.sourceHash);
    const checkpoint = () => save(JOURNAL, journal);
    const checkCode = async () => { for (const step of plan.steps) assert.equal(keccak256((await pc.getBytecode({ address: step.address }))!), step.runtimeHash, `Runtime mismatch ${step.name}`); };
    const send = async (step: any, label: string) => {
        assert.equal(process.env.ZERO_SPLIT_AUTHORIZE_MAINNET, "42161-zero-splits-reviewed", "Explicit mainnet execution flag required");
        assert.equal(await pc.getChainId(), 42161);
        assert(await pc.getGasPrice() <= BigInt(plan.maxFeePerGas), "Gas price exceeded the reviewed fee ceiling");
        mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
        const signedPath = join(PRIVATE, `nonce-${step.nonce}.json`);
        let signed: Hex;
        if (existsSync(signedPath)) signed = read(signedPath).serialized;
        else {
            assert.equal(await pc.getTransactionCount({ address: signer, blockTag: "latest" }), step.nonce, "Signer nonce changed");
            assert.equal(await pc.getTransactionCount({ address: signer, blockTag: "pending" }), step.nonce, "Unexpected pending transaction");
            const key = vars.get("BRB_KEY");
            const account = privateKeyToAccount((key.startsWith("0x") ? key : "0x" + key) as Hex);
            assert.equal(account.address.toLowerCase(), signer.toLowerCase());
            signed = await account.signTransaction({ type: "eip1559", chainId: 42161, nonce: step.nonce, to: step.to, data: step.data, value: 0n, gas: BigInt(step.gas), maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas) });
            writeFileSync(signedPath, j({ serialized: signed }) + "\n", { flag: "wx", mode: 0o600 });
        }
        const txHash = keccak256(signed);
        let row = journal.transactions.find((x: any) => x.nonce === step.nonce);
        if (!row) { row = { label, nonce: step.nonce, transactionHash: txHash, status: "signed", dataHash: keccak256(step.data), to: step.to ?? null }; journal.transactions.push(row); checkpoint(); }
        assert.equal(row.transactionHash, txHash);
        let receipt: any;
        try { receipt = await pc.getTransactionReceipt({ hash: txHash }); } catch { /* Not yet mined. */ }
        if (!receipt) {
            const latestNonce = await pc.getTransactionCount({ address: signer, blockTag: "latest" });
            assert(latestNonce <= step.nonce, "Nonce consumed by another transaction; reconcile before continuing");
            row.status = "broadcasting"; checkpoint();
            try { assert.equal(await pc.sendRawTransaction({ serializedTransaction: signed }), txHash); }
            catch { throw Error(`Broadcast interrupted for ${label}; reconcile known hash ${txHash} before resuming`); }
            receipt = await pc.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 180_000 });
        }
        row.status = receipt.status; row.blockNumber = receipt.blockNumber.toString(); row.gasUsed = receipt.gasUsed.toString(); row.effectiveGasPrice = receipt.effectiveGasPrice.toString(); checkpoint();
        assert.equal(receipt.status, "success", label + " reverted");
        console.log(j({ label, hash: txHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed }));
        return receipt;
    };
    if (phase === "deploy") {
        same(await currentImplementation(), plan.previousImplementation); same(await ctor(plan.previousImplementation), plan.constructorArguments);
        for (const step of plan.steps) {
            const fresh = await payload(step.name, step.address, step.libraries, step.constructorArguments);
            same(fresh, { data: step.data, expectedRuntime: step.expectedRuntime, initcodeHash: step.initcodeHash, runtimeHash: step.runtimeHash, runtimeBytes: step.runtimeBytes });
            const r = await send(step, "deploy " + step.name);
            assert.equal(r.contractAddress.toLowerCase(), step.address.toLowerCase());
            assert.equal(keccak256((await pc.getBytecode({ address: step.address }))!), step.runtimeHash);
        }
        journal.status = "deployed"; checkpoint(); console.log("Five replacement contracts deployed; proxy is still unchanged."); return;
    }
    if (phase === "verify") {
        const alreadyUpgraded = plan.status === "upgraded-verified";
        await checkCode();
        for (const step of plan.steps) {
            await verifyExactCompilerBuild({ address: step.address, artifact: step.name, constructorArguments: step.constructorArguments, libraries: step.libraries });
            step.explorerVerified = true; save(PLAN, plan);
        }
        if (!alreadyUpgraded) { plan.status = "deployed-verified"; journal.status = "deployed-verified"; }
        save(PLAN, plan); checkpoint();
        console.log("All five runtimes match and their exact compiler inputs are explorer-verified; proxy is unchanged."); return;
    }
    assert.equal(phase, "upgrade", "Unknown phase");
    assert.equal(plan.status, "deployed-verified"); await checkCode();
    const fork = read(join(DIR, "actual-address-fork/report.json"));
    assert(fork.passed && fork.localChainId === 31337 && fork.statePreserved && fork.mainnetImplementationUnchanged);
    same(fork.LOCAL_ONLY_newImplementation, plan.steps[4].address); same(fork.constructorArgs, plan.constructorArguments);
    assert(fork.cases.length === 5 && fork.cases.every((c: any) => c.postPaymentRawStorageVerified && c.receiptTransfersReconciled && c.nextRoundBetSimulationPassed));
    same(await currentImplementation(), plan.previousImplementation); same(await ctor(plan.previousImplementation), plan.constructorArguments);
    let idleState: any;
    for (let i = 0; i < 120; i++) {
        idleState = await idle();
        if (!idleState.pendingVrf && idleState.phase === 1 && idleState.participating === 0) break;
        if (i % 10 === 0) console.log(j({ waitingForIdle: idleState }));
        await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    assert(!idleState.pendingVrf && idleState.phase === 1 && idleState.participating === 0, "No idle upgrade window; proxy unchanged");
    const engineSource = readFileSync(join(ROOT, "contracts/libraries/RouletteEngineStorageLib.sol"), "utf8");
    const root = BigInt(/STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(engineSource)![1]);
    const snapshot = async (blockNumber: bigint) => {
        const slots = [];
        for (let i = 0n; i < 64n; i++) slots.push(await pc.getStorageAt({ address: engine.address, slot: toHex(root + i, { size: 32 }), blockNumber }));
        return { blockNumber: blockNumber.toString(), slots };
    };
    const before = await snapshot(await pc.getBlockNumber()); save(join(DIR, "mainnet-state-before.json"), before);
    const simulated = await pc.simulateContract({ address: engine.address, abi: engine.abi, functionName: "upgradeToAndCall", args: [plan.steps[4].address, "0x"], account: signer });
    assert(simulated.request);
    const freshIdle = await idle(); assert(!freshIdle.pendingVrf && freshIdle.phase === 1 && freshIdle.participating === 0, "Round became active; no upgrade sent");
    same(await currentImplementation(), plan.previousImplementation);
    const r = await send(plan.upgrade, "upgrade engine proxy for zero splits");
    same(await currentImplementation(), plan.steps[4].address);
    same(await ctor(plan.steps[4].address), plan.constructorArguments);
    const after = await snapshot(r.blockNumber); save(join(DIR, "mainnet-state-after.json"), after);
    for (let i = 0; i < 64; i++) if (![4, 5, 34].includes(i)) assert.equal(after.slots[i], before.slots[i], `Unexpected configuration slot ${i} changed`);
    assert.equal(BigInt(after.slots[4]!) & ((1n << 64n) - 1n), BigInt(before.slots[4]!) & ((1n << 64n) - 1n));
    assert.equal(await engine.read.payoutParallelLaneCount(), 1);
    const lib = await viem.getContractAt("RouletteBetLib", plan.steps[0].address);
    for (let id = 0n; id < 100n; id++) assert.equal(await lib.read.isValidSplit([id]), id >= 1n && id <= 3n);
    for (const [n, expected] of [[0n, [1n, 2n, 3n]], [1n, [1n, 102n, 104n]], [2n, [2n, 203n, 102n, 205n]], [3n, [3n, 203n, 306n]]] as const) same((await lib.read.getWinningBetTypes([n])).winningSplits, expected);
    journal.status = "upgraded-verified"; journal.upgradeTransactionHash = r.transactionHash; journal.newImplementation = plan.steps[4].address; journal.constructorArgumentsUnchanged = true; journal.configurationStoragePreserved = true; journal.completedAt = new Date().toISOString(); checkpoint();
    const latest = read(join(ROOT, "deployments/arbitrum-one.json"));
    latest.upgradeHistory ??= []; latest.upgradeHistory.push({ kind: "roulette-zero-splits", date: journal.completedAt, previousImplementation: plan.previousImplementation, newImplementation: plan.steps[4].address, previousLinkedLibraries: latest.linkedLibraries, linkedLibraries: plan.linkedLibraries, transactionHash: r.transactionHash, constructorArguments: plan.constructorArguments, report: "reports/upgrades/arbitrum-zero-splits-mainnet-20261029/journal.json" });
    latest.addresses.engineImplementation = plan.steps[4].address; latest.linkedLibraries = plan.linkedLibraries;
    for (const entry of latest.sourceVerification?.contracts ?? []) { const step = plan.steps.find((s: any) => s.name === entry.artifact); if (step) entry.address = step.address; }
    save(join(ROOT, "deployments/arbitrum-one.json"), latest);
    plan.status = "upgraded-verified"; save(PLAN, plan);
    console.log(j({ upgraded: true, proxy: engine.address, implementation: plan.steps[4].address, transactionHash: r.transactionHash, constructorArgumentsUnchanged: true, configurationStoragePreserved: true, payoutLanes: 1 }));
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "Upgrade phase interrupted; inspect the durable public journal before resuming. No automatic new-nonce retry."); process.exitCode = 1; });
