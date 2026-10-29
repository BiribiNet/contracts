import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import hre, { artifacts, network, viem } from "hardhat";
import { createPublicClient, erc20Abi, getAddress, http, parseUnits, zeroAddress, type Address } from "viem";

// This script has no live deployment mode. The upstream gateway only forwards reads.
const READS = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber",
    "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount",
    "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs", "eth_getProof",
    "eth_feeHistory", "eth_gasPrice"]);
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);

async function main() {
    assert.equal(network.name, "hardhat", "Only the disposable Hardhat chain is allowed");
    assert(hre.hardhatArguments.config?.endsWith("hardhat.fork-only.config.ts"), "Use the key-free fork config");
    assert.equal(await (await viem.getPublicClient()).getChainId(), 31337);
    const manifest = JSON.parse(readFileSync(join(__dirname, "../deployments/arbitrum-one.json"), "utf8"));
    const a = manifest.addresses;
    const directory = join(__dirname, "../reports/upgrades/dai-usdc-route-mainnet-20261029");
    mkdirSync(directory, { recursive: true });
    const forwarded: Record<string, number> = {};
    const rejected: string[] = [];
    const report: Record<string, any> = { status: "running", scope: "Isolated local fork; no mainnet writes",
        publicRpcForwardedMethods: forwarded, publicRpcRejectedMethods: rejected };
    const gateway = createServer(async (request, response) => {
        async function forward(body: any) {
            if (!READS.has(body.method)) {
                rejected.push(body.method);
                return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Read-only gateway" } };
            }
            forwarded[body.method] = (forwarded[body.method] ?? 0) + 1;
            let lastError: any;
            for (const url of ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"]) {
                try {
                    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
                        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
                    if (!result.ok) continue;
                    const answer: any = await result.json();
                    if (answer.error) { lastError = answer; continue; }
                    return answer;
                } catch { /* Try the other public read-only source. */ }
            }
            return lastError ?? { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Public RPC unavailable" } };
        }
        try {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const body = JSON.parse(raw);
            const answer = Array.isArray(body) ? await Promise.all(body.map(forward)) : await forward(body);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(answer));
        } catch { response.writeHead(400); response.end(); }
    });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    const listener = gateway.address();
    assert(listener && typeof listener !== "string");
    const url = `http://127.0.0.1:${listener.port}`;
    const source = createPublicClient({ transport: http(url, { timeout: 60000, retryCount: 0 }) });
    try {
        const blocked: any = await (await fetch(url, { method: "POST", body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"],
        }) })).json();
        assert.equal(blocked.error.code, -32601);
        assert.equal(await source.getChainId(), 42161);
        const blockNumber = Number(process.env.ARBITRUM_FORK_BLOCK ?? await source.getBlockNumber());
        assert(Number.isSafeInteger(blockNumber) && blockNumber > 0);
        report.pinnedArbitrumBlock = blockNumber;
        await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url, blockNumber } }] });
        const pc = await viem.getPublicClient();
        assert.equal(await pc.getChainId(), 31337);
        const planPath = join(directory, "plan.json");
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        assert.equal(plan.chainId, 42161);
        assert.equal(await pc.getTransactionCount({ address: plan.signer }), plan.steps[0].nonce, "Planned signer nonce drift");
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [plan.signer] });
        await network.provider.request({ method: "hardhat_setBalance", params: [plan.signer, "0x56bc75e2d63100000"] });
        const wallet = await viem.getWalletClient(plan.signer);
        const engine = await viem.getContractAt("RouletteEngine", plan.engine);
        assert.equal(getAddress(await engine.read.JACKPOT_FUNDER()), getAddress(plan.oldFunder));
        const root = BigInt("0x8a653c570a28b92a786a8846d2fb5907e111615753e347ab6161fea696c7eb00");
        const snapshot = async () => Promise.all(Array.from({ length: 64 }, (_, i) => pc.getStorageAt({ address: plan.engine,
            slot: ("0x" + (root + BigInt(i)).toString(16).padStart(64, "0")) as `0x${string}` })));
        const before = await snapshot();
        const implementationBefore = await pc.getStorageAt({ address: plan.engine, slot: IMPLEMENTATION_SLOT });
        const transactions = [];
        for (const step of plan.steps) {
            const receipt = await pc.waitForTransactionReceipt({ hash: await wallet.sendTransaction({
                account: plan.signer, to: step.to, data: step.data, nonce: step.nonce, gas: BigInt(step.gas), value: 0n,
            }) });
            assert.equal(receipt.status, "success", step.label);
            transactions.push({ label: step.label, localHash: receipt.transactionHash, gasUsed: receipt.gasUsed });
        }
        const code = await pc.getBytecode({ address: plan.newFunder });
        const { keccak256 } = await import("viem");
        assert.equal(keccak256(code!), plan.sourceRuntimeHash, "Exact immutable-patched runtime differs");
        const next = await viem.getContractAt("RoutedBRBJackpotFunder", plan.newFunder);
        for (const [name, value] of Object.entries(plan.settings)) {
            assert.equal(String(await (next.read[name as keyof typeof next.read] as any)()), String(value));
        }
        await network.provider.request({ method: "evm_increaseTime", params: [Number(plan.settings.twapWindowSeconds) + 1] });
        await network.provider.request({ method: "evm_mine", params: [] });
        const receipt = await pc.waitForTransactionReceipt({ hash: await wallet.sendTransaction({
            account: plan.signer, to: plan.activation.to, data: plan.activation.data,
            nonce: plan.activation.nonce, gas: BigInt(plan.activation.gas), value: 0n,
        }) });
        assert.equal(receipt.status, "success");
        assert.equal(getAddress(await engine.read.JACKPOT_FUNDER()), getAddress(plan.newFunder));
        const after = await snapshot();
        for (let i = 0; i < before.length; i++) if (i !== 2) assert.equal(after[i], before[i], `Unexpected engine storage change at ${i}`);
        assert.equal(getAddress(("0x" + after[2]!.slice(-40)) as Address), getAddress(plan.newFunder));
        assert.equal(await pc.getStorageAt({ address: plan.engine, slot: IMPLEMENTATION_SLOT }), implementationBefore);
        const dai = await viem.getContractAt("MockDAI", plan.constructorArguments[6]);
        const usdc = await viem.getContractAt("MockUSDC", plan.constructorArguments[7]);
        const brb = await viem.getContractAt("BRBToken", plan.constructorArguments[1]);
        const router = await viem.getContractAt("UniswapV2Router02", plan.constructorArguments[2]);
        const old = await viem.getContractAt("BRBJackpotFunder", plan.oldFunder);
        const oldBefore = await old.read.fundingAccounts([3]);
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [plan.engine] });
        await network.provider.request({ method: "hardhat_setBalance", params: [plan.engine, "0x56bc75e2d63100000"] });
        const gas: Record<string, string> = {};
        for (const [label, token, market, amount, path] of [
            ["DAI", dai, 3, parseUnits("0.03", 18), [dai.address, usdc.address, brb.address]],
            ["USDC", usdc, 2, parseUnits("0.03", 6), [usdc.address, brb.address]],
            ["BRB", brb, 1, parseUnits("0.3", 18), []],
        ] as const) {
            const quote = path.length ? (await router.read.getAmountsOut([amount, [...path]])).at(-1)! : amount;
            await wallet.writeContract({ address: token.address, abi: erc20Abi, functionName: "transfer",
                args: [plan.newFunder, amount], account: plan.signer });
            await next.write.queueFunding([market, token.address, amount], { account: plan.engine });
            const treasury = await brb.read.balanceOf([plan.constructorArguments[3]]);
            const supply = await brb.read.totalSupply();
            const processed = await pc.waitForTransactionReceipt({ hash: await next.write.processFunding([market], { gas: 1500000n }) });
            const account = await next.read.fundingAccounts([market]);
            assert.equal(account[1], 0n); assert.equal(account[3], amount); assert.equal(account[4], quote);
            assert.equal(account[4], account[5] + account[6]);
            assert.equal(await brb.read.balanceOf([plan.constructorArguments[3]]) - treasury, account[5]);
            assert.equal(supply - await brb.read.totalSupply(), account[6]);
            assert.equal(await token.read.allowance([plan.newFunder, router.address]), 0n);
            gas[label] = processed.gasUsed.toString();
        }
        assert.deepEqual(await old.read.fundingAccounts([3]), oldBefore);
        report.status = "passed"; report.exactPlan = true; report.sourceRuntimeHash = plan.sourceRuntimeHash;
        report.newFunder = plan.newFunder; report.transactions = transactions; report.gas = gas;
        report.onlyEngineStorageSlotChanged = 2; report.implementationUnchanged = true; report.oldDaiQueuePreserved = true;
        report.checks = ["Exact planned deployment address, calldata and nonces", "Exact live constructor immutables and copied policies",
            "Only JACKPOT_FUNDER storage slot changes", "Engine implementation and all other captured engine storage unchanged",
            "DAI routed and USDC direct swaps plus BRB distribution reconcile", "Old accepted DAI residual remains untouched"];
        plan.actualAddressForkPassed = true; plan.actualAddressForkBlock = blockNumber;
        writeFileSync(planPath, json(plan) + "\n");
        console.log(json({ status: report.status, newFunder: plan.newFunder, blockNumber, gas, checks: report.checks }));
    } catch (error) {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        writeFileSync(join(directory, "actual-address-fork.json"), json(report) + "\n");
        await network.provider.request({ method: "hardhat_reset", params: [] });
        await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
