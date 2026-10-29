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
    const directory = join(__dirname, "../reports/upgrades/dai-usdc-route-draft-20261029");
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
        const [admin] = await viem.getWalletClients();
        const donor = manifest.deployer as Address;
        const engine = await viem.getContractAt("RouletteEngine", a.engine);
        const oldAddress = await engine.read.JACKPOT_FUNDER();
        const old = await viem.getContractAt("BRBJackpotFunder", oldAddress);
        const dai = await viem.getContractAt("MockDAI", manifest.markets.dai.asset);
        const usdc = await viem.getContractAt("MockUSDC", manifest.markets.usdc.asset);
        const brb = await viem.getContractAt("BRBToken", a.brb);
        const router = await viem.getContractAt("UniswapV2Router02", await old.read.router());
        const factory = await viem.getContractAt("UniswapV2Factory", await router.read.factory());
        const pools = {
            daiBrb: await factory.read.getPair([dai.address, brb.address]),
            daiUsdc: await factory.read.getPair([dai.address, usdc.address]),
            usdcBrb: await factory.read.getPair([usdc.address, brb.address]),
        };
        assert.equal(pools.daiBrb, zeroAddress);
        assert.notEqual(pools.daiUsdc, zeroAddress);
        assert.notEqual(pools.usdcBrb, zeroAddress);
        report.existingPools = pools;
        const before = {
            implementation: await pc.getStorageAt({ address: engine.address, slot: IMPLEMENTATION_SLOT }),
            currentRound: await engine.read.currentGlobalRound(),
            round96: await engine.read.globalRoundState([96n]),
            oldDaiAccount: await old.read.fundingAccounts([3]),
            oldDaiBalance: await dai.read.balanceOf([oldAddress]),
            bankBalances: [await dai.read.balanceOf([manifest.markets.dai.bank]),
                await usdc.read.balanceOf([manifest.markets.usdc.bank]), await brb.read.balanceOf([manifest.markets.brb.bank])],
        };
        const next = await viem.deployContract("RoutedBRBJackpotFunder", [engine.address, brb.address,
            router.address, a.jackpotTreasury, a.sideBet, admin.account.address, dai.address, usdc.address]);
        const setters = [["swapAssetTotalBps", "setSwapAssetBps"], ["slippageBps", "setSlippageBps"],
            ["coldSlippageBps", "setColdSlippageBps"], ["twapWindowSeconds", "setTwapWindowSeconds"],
            ["maxSwapReserveBps", "setMaxSwapReserveBps"]] as const;
        for (const [getter, setter] of setters) {
            const value = await (old.read[getter] as any)();
            if (await (next.read[getter] as any)() !== value) await (next.write[setter] as any)([value]);
        }
        await next.write.setTreasuryBrbSplit([await old.read.treasuryBrbNumerator(), await old.read.treasuryBrbDenominator()]);
        for (const who of new Set([donor, manifest.protocolAdmin as Address, engine.address])) {
            await network.provider.request({ method: "hardhat_impersonateAccount", params: [who] });
            await network.provider.request({ method: "hardhat_setBalance", params: [who, "0x56bc75e2d63100000"] });
        }
        assert(await engine.read.hasRole([await engine.read.ENGINE_FEE_ROLE(), manifest.protocolAdmin]));
        await engine.write.setJackpotFunder([next.address], { account: manifest.protocolAdmin });
        assert.equal(getAddress(await engine.read.JACKPOT_FUNDER()), getAddress(next.address));
        const gas: Record<string, string> = {};
        const swaps: any[] = [];
        for (const [label, token, market, amount, path] of [
            ["DAI cold", dai, 3, parseUnits("0.03", 18), [dai.address, usdc.address, brb.address]],
            ["USDC direct", usdc, 2, parseUnits("0.03", 6), [usdc.address, brb.address]],
            ["BRB direct", brb, 1, parseUnits("0.3", 18), []],
        ] as const) {
            assert(await token.read.balanceOf([donor]) >= amount, "Fork donor lacks fixture funds");
            const quote = path.length ? (await router.read.getAmountsOut([amount, [...path]])).at(-1)! : amount;
            await admin.writeContract({ address: token.address, abi: erc20Abi, functionName: "transfer",
                args: [next.address, amount], account: donor });
            await next.write.queueFunding([market, token.address, amount], { account: engine.address });
            const treasuryBefore = await brb.read.balanceOf([a.jackpotTreasury]);
            const supplyBefore = await brb.read.totalSupply();
            const hash = await next.write.processFunding([market], { gas: 1500000n });
            const receipt = await pc.waitForTransactionReceipt({ hash });
            assert.equal(receipt.status, "success");
            const account = await next.read.fundingAccounts([market]);
            assert.equal(account[1], 0n, `${label} left an unexpected queue`);
            assert.equal(account[3], amount);
            assert.equal(account[4], quote);
            assert.equal(account[4], account[5] + account[6]);
            assert.equal(await brb.read.balanceOf([a.jackpotTreasury]) - treasuryBefore, account[5]);
            assert.equal(supplyBefore - await brb.read.totalSupply(), account[6]);
            assert.equal(await token.read.allowance([next.address, router.address]), 0n);
            gas[label] = receipt.gasUsed.toString();
            swaps.push({ label, amount, quote, account, localTransaction: hash });
        }
        // Warm the real pool observations and execute a second DAI chunk with the same keeper limit.
        await network.provider.request({ method: "evm_increaseTime", params: [1801] });
        await network.provider.request({ method: "evm_mine", params: [] });
        await dai.write.transfer([next.address, parseUnits("0.03", 18)], { account: donor });
        await next.write.queueFunding([3, dai.address, parseUnits("0.03", 18)], { account: engine.address });
        const warm = await pc.waitForTransactionReceipt({ hash: await next.write.processFunding([3], { gas: 1500000n }) });
        assert.equal((await next.read.fundingAccounts([3]))[1], 0n);
        gas["DAI warm"] = warm.gasUsed.toString();
        assert.deepEqual(await old.read.fundingAccounts([3]), before.oldDaiAccount);
        assert.equal(await dai.read.balanceOf([oldAddress]), before.oldDaiBalance);
        assert.equal(await pc.getStorageAt({ address: engine.address, slot: IMPLEMENTATION_SLOT }), before.implementation);
        assert.equal(await engine.read.currentGlobalRound(), before.currentRound);
        assert.deepEqual(await engine.read.globalRoundState([96n]), before.round96);
        assert.deepEqual([await dai.read.balanceOf([manifest.markets.dai.bank]),
            await usdc.read.balanceOf([manifest.markets.usdc.bank]), await brb.read.balanceOf([manifest.markets.brb.bank])], before.bankBalances);
        // The old queue cannot be swept to the replacement. Do not treat it as imported input.
        await assert.rejects(old.write.sweepToken([dai.address, next.address, before.oldDaiAccount[1]], { account: manifest.protocolAdmin }));
        report.status = "passed";
        report.replacementOnLocalForkOnly = next.address;
        report.runtimeBytes = ((await artifacts.readArtifact("RoutedBRBJackpotFunder")).deployedBytecode.length - 2) / 2;
        report.swaps = swaps;
        report.gasUsed = gas;
        report.oldDaiQueuePreserved = before.oldDaiAccount;
        report.checks = ["Real DAI/USDC and USDC/BRB pools, no pair creation", "DAI cold and warm worker execution",
            "USDC direct swap", "BRB direct distribution", "Exact treasury and burn transfers", "Zero residual router approvals",
            "Engine pointer change only, no implementation upgrade", "Round state and all bank token balances unchanged",
            "Old queued DAI remains backed and untouched; cannot be swept", "Public RPC rejects transaction submission"];
        console.log(json({ status: report.status, blockNumber, gas, checks: report.checks }));
    } catch (error) {
        report.status = "failed";
        report.error = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        writeFileSync(join(directory, "fork-rehearsal.json"), json(report) + "\n");
        await network.provider.request({ method: "hardhat_reset", params: [] });
        await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
