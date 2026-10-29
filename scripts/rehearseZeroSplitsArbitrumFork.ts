/** LOCAL FORK ONLY. No private keys, remote wallet clients or public-network writes. */
import hre, { artifacts, network, viem } from "hardhat";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createPublicClient, http, parseAbi, encodeAbiParameters, decodeEventLog, keccak256, zeroAddress, zeroHash, toHex, type Address, type Hex } from "viem";

const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const READ_METHODS = new Set([
    "eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
    "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_call",
    "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs", "eth_getProof", "eth_gasPrice", "eth_feeHistory",
]);
const UPSTREAMS = ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"];
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
const fq = (name: string) => `contracts/libraries/${name}.sol:${name}`;

async function main() {
    assert.equal(network.name, "hardhat", "ABORT: only the in-process Hardhat network is allowed");
    assert.equal(Number(await network.provider.request({ method: "eth_chainId" })), 31337, "ABORT: local chain ID required");
    assert.deepEqual(Object.keys(hre.config.networks).filter(name => name !== "localhost"), ["hardhat"], "Unexpected configured network");
    const m = JSON.parse(readFileSync(join(__dirname, "../deployments/arbitrum-one.json"), "utf8"));
    const output = process.env.ZERO_SPLIT_FORK_PLAN
        ? join(__dirname, "../reports/upgrades/arbitrum-zero-splits-mainnet-20261029/actual-address-fork")
        : join(__dirname, "../reports/upgrades/arbitrum-zero-splits-fork-20261029");
    mkdirSync(output, { recursive: true });
    const upstreamMethods: Record<string, number> = {};
    const blockedMethods: string[] = [];
    const localWrites: Record<string, number> = {};
    const transactions: any[] = [];
    let failure: string | undefined;
    let result: any = {};

    // This gateway is the only upstream connection. It cannot forward a signing or send method.
    async function forward(request: any) {
        if (!READ_METHODS.has(request.method)) {
            blockedMethods.push(request.method);
            return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Read-only fork gateway: method forbidden" } };
        }
        upstreamMethods[request.method] = (upstreamMethods[request.method] ?? 0) + 1;
        for (const endpoint of UPSTREAMS) {
            try {
                const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) });
                if (!response.ok) continue;
                const body: any = await response.json();
                if (body.error && /rate|limit|timeout|busy/i.test(body.error.message ?? "")) continue;
                return body;
            } catch { /* Retry a read on the other fixed public endpoint. */ }
        }
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Read-only upstream unavailable" } };
    }
    const gateway = createServer(async (request, response) => {
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
    const address = gateway.address();
    assert(address && typeof address !== "string");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const source = createPublicClient({ transport: http(gatewayUrl, { timeout: 60_000, retryCount: 0 }) });
    const originalRequest = network.provider.request.bind(network.provider);
    network.provider.request = (async (args: any) => {
        if (/^(eth_send|hardhat_|evm_)/.test(args.method)) {
            assert.equal(network.name, "hardhat");
            assert.equal(Number(await originalRequest({ method: "eth_chainId" })), 31337, "ABORT: write outside local chain");
            localWrites[args.method] = (localWrites[args.method] ?? 0) + 1;
        }
        return originalRequest(args);
    }) as typeof network.provider.request;

    try {
        const rejected: any = await (await fetch(gatewayUrl, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] }) })).json();
        assert.equal(rejected.error.code, -32601, "Gateway must block broadcasts");
        assert.equal(await source.getChainId(), 42161);
        const pinned = await source.getBlock();
        const remoteImplementationBefore = await source.getStorageAt({ address: m.addresses.engine, slot: SLOT });
        console.log(`SAFETY: upstream read-only gateway tested; source 42161 at block ${pinned.number}; all writes require local 31337.`);
        await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: gatewayUrl, blockNumber: Number(pinned.number) } }] });
        const pc = await viem.getPublicClient();
        assert.equal(await pc.getChainId(), 31337);
        const [, player] = await viem.getWalletClients();
        const engine = await viem.getContractAt("RouletteEngine", m.addresses.engine);
        const scheduler = await viem.getContractAt("UpkeepScheduler", m.addresses.scheduler);
        const registry = await viem.getContractAt("MarketRegistry", m.addresses.registry);
        const brb = await viem.getContractAt("BRBToken", m.addresses.brb);
        const oldImplementation = (`0x${remoteImplementationBefore!.slice(-40)}`) as Address;
        assert.equal(oldImplementation.toLowerCase(), m.addresses.engineImplementation.toLowerCase());
        assert.equal(await engine.read.payoutParallelLaneCount(), 1);
        assert(await engine.read.hasRole([zeroHash, m.protocolAdmin]));
        const impersonate = async (who: Address) => {
            await network.provider.request({ method: "hardhat_impersonateAccount", params: [who] });
            await network.provider.request({ method: "hardhat_setBalance", params: [who, "0x56bc75e2d63100000"] });
        };
        const receipt = async (hash: Hex, label: string) => {
            assert.equal(await pc.getChainId(), 31337);
            const r = await pc.waitForTransactionReceipt({ hash });
            assert.equal(r.status, "success", label);
            transactions.push({ label, hash, localChainId: 31337 });
            return r;
        };
        await impersonate(m.protocolAdmin);
        await impersonate(m.automation.keeper);
        await impersonate(m.vrf.coordinator);
        const drain = async () => {
            for (let n = 0; n < 100; n++) {
                const [needed, data] = await scheduler.read.checkUpkeep(["0x"]);
                if (!needed) return;
                await receipt(await scheduler.write.performUpkeep([data], { account: m.automation.keeper, gas: 8_000_000n }), "local scheduler upkeep");
            }
            throw Error("Local upkeep failed to converge");
        };
        const fulfill = async (outcome: bigint) => {
            const round = await engine.read.currentGlobalRound();
            const d = await engine.read.roundDiagnostics([round]);
            assert(d.requestId > 0n);
            await receipt(await engine.write.rawFulfillRandomWords([d.requestId, [outcome, 35n]], { account: m.vrf.coordinator, gas: 5_000_000n }), "local simulated VRF callback");
        };
        const initialRound = await engine.read.currentGlobalRound();
        const initialDiagnostics = await engine.read.roundDiagnostics([initialRound]);
        for (let n = 0; n < 5; n++) {
            const rid = await engine.read.currentGlobalRound();
            const d = await engine.read.roundDiagnostics([rid]);
            if (!await engine.read.hasPendingVrf() && await engine.read.roundPhase([rid]) === 1 && d.marketsParticipating === 0) break;
            if (await engine.read.hasPendingVrf()) await fulfill(36n);
            else {
                await network.provider.request({ method: "evm_increaseTime", params: [Number(await engine.read.ROUND_DURATION()) + 5] });
                await network.provider.request({ method: "evm_mine", params: [] });
            }
            await drain();
        }
        assert(!await engine.read.hasPendingVrf(), "Prepare an idle local round before upgrade");
        const idleRound = await engine.read.currentGlobalRound();
        assert.equal((await engine.read.roundDiagnostics([idleRound])).marketsParticipating, 0);
        console.log(`Local fork ready: proxy ${engine.address}, idle round ${idleRound}, payout lanes 1.`);

        const snapshot = async () => {
            const wiring = await Promise.all([engine.read.REGISTRY(), engine.read.JACKPOT_FUNDER(), engine.read.JACKPOT_TREASURY(), engine.read.UPKEEP_SCHEDULER(), engine.read.INFRA_RECIPIENT(), engine.read.VRF_SUBSCRIPTION_ID(), engine.read.VRF_CALLBACK_GAS_LIMIT(), engine.read.ROUND_DURATION(), engine.read.payoutParallelLaneCount(), engine.read.withdrawalQueueBatchSize(), engine.read.maxWithdrawalQueueLength(), engine.read.BRB_REFERRAL(), engine.read.VRF_KEY_HASH_2_GWEI(), engine.read.VRF_KEY_HASH_30_GWEI(), engine.read.VRF_KEY_HASH_150_GWEI(), engine.read.VRF_CONFIRMATIONS()]);
            const markets = [];
            for (let mid = 1; mid <= Number(await registry.read.marketCount()); mid++) {
                const cfg = await registry.read.getMarket([mid]);
                const bank = await viem.getContractAt("BankVault4626", cfg.bank);
                markets.push({ cfg, assets: await bank.read.totalAssets(), supply: await bank.read.totalSupply(), locked: await bank.read.lockedBetLiquidity(), minimum: await bank.read.minBet(), adminShares: await bank.read.balanceOf([m.protocolAdmin]), infraShares: await bank.read.balanceOf([m.infraWallet]), balance: await pc.readContract({ address: cfg.asset, abi: parseAbi(["function balanceOf(address) view returns(uint256)"]), functionName: "balanceOf", args: [cfg.bank] }) });
            }
            const rounds = [];
            for (let r = idleRound > 3n ? idleRound - 3n : 1n; r <= idleRound; r++) {
                rounds.push({ round: r, global: await engine.read.globalRoundState([r]), diagnostics: await engine.read.roundDiagnostics([r]), markets: await Promise.all(markets.map((_, index) => engine.read.marketRoundStateByRound([r, index + 1]))) });
            }
            const storage = [];
            // This source constant was separately compared with the verified explorer layout.
            const storageSource = readFileSync(join(__dirname, "../contracts/libraries/RouletteEngineStorageLib.sol"), "utf8");
            const namespaceMatch = /STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(storageSource);
            assert(namespaceMatch, "Missing engine storage namespace");
            const namespace = BigInt(namespaceMatch[1]);
            for (let offset = 0n; offset < 64n; offset++) storage.push(await pc.getStorageAt({ address: engine.address, slot: toHex(namespace + offset, { size: 32 }) }));
            return json({ wiring, markets, rounds, currentRound: await engine.read.currentGlobalRound(), admin: await engine.read.hasRole([zeroHash, m.protocolAdmin]), storage });
        };
        const before = await snapshot();
        writeFileSync(join(output, "state-before-upgrade.json"), before + "\n");
        const args = [m.vrf.coordinator, await engine.read.VRF_KEY_HASH_2_GWEI(), await engine.read.VRF_KEY_HASH_30_GWEI(), await engine.read.VRF_KEY_HASH_150_GWEI(), await engine.read.VRF_CONFIRMATIONS(), await engine.read.BRB_REFERRAL()] as const;
        let deployed: Record<string, Address> = { ...m.linkedLibraries };
        let implementation: { address: Address };
        if (process.env.ZERO_SPLIT_FORK_PLAN) {
            const plan = JSON.parse(readFileSync(process.env.ZERO_SPLIT_FORK_PLAN, "utf8"));
            assert.equal(plan.status, "deployed-verified");
            assert.equal(plan.chainId, 42161);
            assert.equal(plan.proxy.toLowerCase(), engine.address.toLowerCase());
            assert.equal(plan.previousImplementation.toLowerCase(), oldImplementation.toLowerCase());
            assert.equal(json(plan.constructorArguments).toLowerCase(), json(args).toLowerCase());
            for (const step of plan.steps) assert.equal(keccak256((await pc.getBytecode({ address: step.address }))!), step.runtimeHash);
            deployed = plan.linkedLibraries;
            implementation = await viem.getContractAt("RouletteEngine", plan.steps[4].address);
            console.log("Rehearsing with the exact verified mainnet replacement addresses, on LOCAL chain 31337 only.");
        } else {
            const bet = await viem.deployContract("RouletteBetLib"); deployed.rouletteBetLib = bet.address;
            const codec = await viem.deployContract("RouletteBetCodecLib", [], { libraries: { [fq("RouletteBetLib")]: bet.address } }); deployed.rouletteBetCodecLib = codec.address;
            const sweep = await viem.deployContract("RoulettePayoutSweepLib", [], { libraries: { [fq("RouletteBetLib")]: bet.address, [fq("RoulettePayoutMulLib")]: deployed.roulettePayoutMulLib } }); deployed.roulettePayoutSweepLib = sweep.address;
            const scan = await viem.deployContract("RouletteUpkeepScanLib", [], { libraries: { [fq("JackpotBatchLib")]: deployed.jackpotBatchLib, [fq("RouletteJackpotCollectLib")]: deployed.rouletteJackpotCollectLib, [fq("RoulettePayoutSweepLib")]: sweep.address } }); deployed.rouletteUpkeepScanLib = scan.address;
            const links = { [fq("JackpotBatchLib")]: deployed.jackpotBatchLib, [fq("RouletteBetCodecLib")]: codec.address, [fq("RouletteLiabilityMathLib")]: deployed.rouletteLiabilityMathLib, [fq("RoulettePayoutSweepLib")]: sweep.address, [fq("RouletteJackpotCollectLib")]: deployed.rouletteJackpotCollectLib, [fq("RouletteExposureLib")]: deployed.rouletteExposureLib, [fq("RouletteUpkeepScanLib")]: scan.address };
            implementation = await viem.deployContract("RouletteEngine", args, { libraries: links });
        }
        const upgrade = await receipt(await engine.write.upgradeToAndCall([implementation.address, "0x"], { account: m.protocolAdmin, gas: 8_000_000n }), "LOCAL FORK proxy upgrade");
        assert.equal((await pc.getStorageAt({ address: engine.address, slot: SLOT }))!.slice(-40).toLowerCase(), implementation.address.slice(2).toLowerCase());
        const after = await snapshot();
        assert.equal(after, before, "Upgrade changed existing application state");
        writeFileSync(join(output, "state-after-upgrade.json"), after + "\n");
        const trace: any = await network.provider.request({ method: "debug_traceTransaction", params: [upgrade.transactionHash, { disableMemory: true, disableStorage: true }] });
        const stores = trace.structLogs.filter((step: any) => step.op === "SSTORE").map((step: any) => ({ depth: step.depth, slot: "0x" + step.stack[step.stack.length - 1].replace(/^0x/, "").padStart(64, "0"), value: "0x" + step.stack[step.stack.length - 2].replace(/^0x/, "").padStart(64, "0") }));
        assert.equal(stores.length, 1, "Upgrade must write only the implementation slot");
        assert.equal(stores[0].slot, SLOT);
        assert.equal(stores[0].value.slice(-40).toLowerCase(), implementation.address.slice(2).toLowerCase());
        console.log("Local upgrade passed: state snapshots identical; trace writes only the EIP-1967 implementation slot.");

        const brbMarket = await registry.read.getMarket([1]);
        assert.equal(brbMarket.asset.toLowerCase(), brb.address.toLowerCase());
        const bank = await viem.getContractAt("BankVault4626", brbMarket.bank);
        const stake = await bank.read.minBet();
        const holder = m.marketingWallet as Address;
        assert(await brb.read.balanceOf([holder]) >= stake * 100n, "Local fixture funding holder has insufficient BRB");
        await impersonate(holder);
        await receipt(await brb.write.transfer([player.account.address, stake * 100n], { account: holder }), "local fixture player funding");
        await receipt(await brb.write.approve([bank.address, stake * 100n], { account: player.account }), "local player approval");
        const ticket = (ids: bigint[], amounts: bigint[]) => encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256[]" }], [ids.map(() => 2n), ids, amounts]);
        for (let id = 0n; id <= 36n; id++) {
            if (id >= 1n && id <= 3n) continue;
            let rejected = false;
            try { await pc.simulateContract({ address: bank.address, abi: bank.abi, functionName: "placeBet", args: [stake, ticket([id], [stake]), zeroAddress], account: player.account.address }); }
            catch (error: any) { assert(String(error).includes("InvalidBetNumber"), "Unexpected invalid-split error"); rejected = true; }
            assert(rejected, `Invalid zero split ${id} accepted`);
        }
        const engineNamespace = BigInt(/STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(readFileSync(join(__dirname, "../contracts/libraries/RouletteEngineStorageLib.sol"), "utf8"))![1]);
        const bankNamespace = BigInt(/BANK_VAULT_STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(readFileSync(join(__dirname, "../contracts/BankVault4626.sol"), "utf8"))![1]);
        const tokenBuild: any = await artifacts.getBuildInfo("contracts/BRBToken.sol:BRBToken");
        const tokenBalanceField = tokenBuild.output.contracts["contracts/BRBToken.sol"].BRBToken.storageLayout.storage.find((field: any) => field.label === "_balances");
        assert(tokenBalanceField, "Missing compiler-derived ERC20 balance slot");
        const mapSlot = (key: bigint, slot: bigint) => BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [key, slot])));
        const rawWord = async (who: Address, slot: bigint) => (await pc.getStorageAt({ address: who, slot: toHex(slot, { size: 32 }) })) ?? zeroHash;
        const rawWords = async (who: Address, base: bigint, count: number) => {
            const words = [];
            for (let offset = 0; offset < count; offset++) words.push(await rawWord(who, base + BigInt(offset)));
            return words;
        };
        const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
        let checkpoint = await network.provider.request({ method: "evm_snapshot", params: [] });
        const cases = [];
        for (const outcome of [0n, 1n, 2n, 3n, 4n]) {
            assert(await network.provider.request({ method: "evm_revert", params: [checkpoint] }));
            checkpoint = await network.provider.request({ method: "evm_snapshot", params: [] });
            const round = await engine.read.currentGlobalRound();
            const initialBalance = await brb.read.balanceOf([player.account.address]);
            const beforeCase = JSON.parse(await snapshot());
            const bankRawBefore = await rawWords(bank.address, bankNamespace, 16);
            const firstCaseTransaction = transactions.length;
            const ids = [1n, 2n, 3n, 102n, 104n];
            const amounts = [stake, stake * 2n, stake * 3n, stake * 4n, stake * 5n];
            await receipt(await bank.write.placeBet([stake * 15n, ticket(ids, amounts), zeroAddress], { account: player.account, gas: 5_000_000n }), `local ticket for outcome ${outcome}`);
            await network.provider.request({ method: "evm_increaseTime", params: [Number(await engine.read.ROUND_DURATION()) + 5] });
            await network.provider.request({ method: "evm_mine", params: [] });
            await drain();
            assert(await engine.read.hasPendingVrf());
            await fulfill(outcome);
            await drain();
            const multipliers: Record<string, bigint> = { "0": 6n, "1": 10n, "2": 6n, "3": 3n, "4": 5n };
            const expectedGross = multipliers[String(outcome)] * stake * 18n;
            const balance = await brb.read.balanceOf([player.account.address]);
            assert.equal(balance, initialBalance - stake * 15n + expectedGross, `Wrong payout for outcome ${outcome}`);
            assert((await engine.read.marketRoundStateByRound([round, 1])).settled);
            assert.equal(await bank.read.lockedBetLiquidity(), 0n);

            // Read physical storage after payment, independently of Solidity's public getters.
            const afterCase = JSON.parse(await snapshot());
            const nextRound = round + 1n;
            assert.equal(BigInt(afterCase.currentRound), nextRound);
            assert.equal(await engine.read.roundPhase([nextRound]), 1);
            assert.deepEqual(afterCase.wiring, beforeCase.wiring, "Configuration changed during settlement");
            assert.equal(afterCase.admin, beforeCase.admin);
            for (let offset = 0; offset < 64; offset++) {
                if (offset !== 4) assert.equal(afterCase.storage[offset], beforeCase.storage[offset], `Unexpected namespace slot change at ${offset}`);
            }
            const packedBefore = BigInt(beforeCase.storage[4]);
            const packedAfter = BigInt(afterCase.storage[4]);
            assert.equal(packedAfter & ((1n << 64n) - 1n), packedBefore & ((1n << 64n) - 1n), "Packed gas/duration fields changed");
            assert.equal((packedAfter >> 64n) & ((1n << 64n) - 1n), nextRound, "Raw global round differs from getter");
            assert.deepEqual(afterCase.rounds.filter((row: any) => BigInt(row.round) < round), beforeCase.rounds.filter((row: any) => BigInt(row.round) < round), "Historical rounds changed");
            for (let index = 0; index < beforeCase.markets.length; index++) {
                const oldMarket = beforeCase.markets[index];
                const newMarket = afterCase.markets[index];
                for (const field of ["cfg", "supply", "minimum", "adminShares", "infraShares"]) assert.deepEqual(newMarket[field], oldMarket[field], `Market ${index + 1} ${field} changed`);
                const expectedDelta = index === 0 ? stake * 15n - expectedGross : 0n;
                assert.equal(BigInt(newMarket.assets), BigInt(oldMarket.assets) + expectedDelta);
                assert.equal(BigInt(newMarket.balance), BigInt(oldMarket.balance) + expectedDelta);
                assert.equal(newMarket.locked, oldMarket.locked);
            }
            const bankRawAfter = await rawWords(bank.address, bankNamespace, 16);
            assert.deepEqual(bankRawAfter, bankRawBefore, "Vault configuration/queue storage changed");
            const rawGlobal = await rawWords(engine.address, mapSlot(round, engineNamespace + 10n), 8);
            const marketBase = mapSlot(1n, mapSlot(round, engineNamespace + 11n));
            const rawMarket = await rawWords(engine.address, marketBase, 6);
            const winningCounts: Record<string, bigint> = { "0": 3n, "1": 3n, "2": 2n, "3": 1n, "4": 1n };
            assert.equal(BigInt(rawGlobal[0]) & 0xffffn, 0x0101n, "Raw VRF request/fulfillment flags");
            assert.equal(BigInt(rawGlobal[1]), outcome, "Raw random word");
            assert.equal(BigInt(rawGlobal[2]) & 255n, outcome, "Raw winning number");
            assert.equal((BigInt(rawGlobal[2]) >> 8n) & 255n, 0n, "Unexpected jackpot flag");
            assert.equal(BigInt(rawMarket[0]) & 255n, 1n, "Raw betsReleased flag");
            assert.equal(BigInt(rawMarket[1]), winningCounts[String(outcome)], "Raw winning bet count");
            assert.equal(BigInt(rawMarket[2]), expectedGross, "Raw bankPaidRunning");
            assert.equal(BigInt(rawMarket[3]) & 255n, 1n, "Raw settled flag");
            assert.equal(BigInt(rawMarket[4]), stake * 15n, "Raw total stake");
            assert.equal(BigInt(rawMarket[5]), 1n, "Raw ticket count");
            const rawCursor = await rawWord(engine.address, mapSlot(0n, mapSlot(1n, mapSlot(round, engineNamespace + 12n))));
            const rawWinnerCount = await rawWord(engine.address, mapSlot(0n, mapSlot(1n, mapSlot(round, engineNamespace + 13n))));
            assert.equal(BigInt(rawCursor), winningCounts[String(outcome)]);
            assert.equal(rawCursor, rawWinnerCount, "Payout cursor did not consume exactly the winning rows");
            assert.equal(BigInt(await rawWord(engine.address, mapSlot(round, engineNamespace + 29n))), 1n);
            assert.equal(BigInt(await rawWord(engine.address, mapSlot(round, engineNamespace + 30n))), 1n);
            const rawPlayerBalance = await rawWord(brb.address, mapSlot(BigInt(player.account.address), BigInt(tokenBalanceField.slot)));
            const rawBankBalance = await rawWord(brb.address, mapSlot(BigInt(bank.address), BigInt(tokenBalanceField.slot)));
            assert.equal(BigInt(rawPlayerBalance), balance, "Raw player token balance differs from paid balance");
            assert.equal(BigInt(rawBankBalance), BigInt(afterCase.markets[0].balance));
            let stakeTransfers = 0n;
            let paymentTransfers = 0n;
            for (const transaction of transactions.slice(firstCaseTransaction)) {
                const transactionReceipt = await pc.getTransactionReceipt({ hash: transaction.hash });
                for (const log of transactionReceipt.logs) {
                    if (log.address.toLowerCase() !== brb.address.toLowerCase()) continue;
                    try {
                        const decoded = decodeEventLog({ abi: transferAbi, topics: log.topics, data: log.data });
                        if (decoded.args.from.toLowerCase() === player.account.address.toLowerCase() && decoded.args.to.toLowerCase() === bank.address.toLowerCase()) stakeTransfers += decoded.args.value;
                        if (decoded.args.from.toLowerCase() === bank.address.toLowerCase() && decoded.args.to.toLowerCase() === player.account.address.toLowerCase()) paymentTransfers += decoded.args.value;
                    } catch { /* BRB also emits unrelated vote/checkpoint events. */ }
                }
            }
            assert.equal(stakeTransfers, stake * 15n);
            assert.equal(paymentTransfers, expectedGross, "Payment receipts do not match raw token balances");
            await pc.simulateContract({ address: bank.address, abi: bank.abi, functionName: "placeBet", args: [stake, ticket([2n], [stake]), zeroAddress], account: player.account.address });
            writeFileSync(join(output, `storage-after-payment-outcome-${outcome}.json`), json({ round, nextRound, outcome, rawGlobal, rawMarket, rawCursor, rawWinnerCount, rawPlayerBalance, rawBankBalance, rawBankBefore: bankRawBefore, rawBankAfter: bankRawAfter, stateBefore: beforeCase, stateAfter: afterCase, stakeTransfers, paymentTransfers, configurationPreserved: true, historicalRoundsPreserved: true, nextRoundBetSimulationPassed: true }) + "\n");
            cases.push({ outcome, round, stake, expectedGross, actualGross: balance - initialBalance + stake * 15n, settled: true, postPaymentRawStorageVerified: true, receiptTransfersReconciled: true, nextRoundBetSimulationPassed: true });
            console.log(`Local outcome ${outcome}: payment receipts, raw storage, unchanged configuration and next-round bet verified.`);
        }
        const remoteImplementationAfter = await source.getStorageAt({ address: m.addresses.engine, slot: SLOT });
        assert.equal(remoteImplementationAfter, remoteImplementationBefore, "Unexpected upstream implementation change");
        result = { sourceChainId: 42161, sourceBlock: pinned.number, localChainId: await pc.getChainId(), proxy: engine.address, previousImplementation: oldImplementation, LOCAL_ONLY_newImplementation: implementation.address, LOCAL_ONLY_libraries: deployed, initialRound, initialDiagnostics, upgradedAtRound: idleRound, constructorArgs: args, statePreserved: true, upgradeStorageWrites: stores, invalidZeroSplitsRejected: "0/0 and 0/4 through 0/36", payoutLanes: await engine.read.payoutParallelLaneCount(), cases, mainnetImplementationUnchanged: remoteImplementationAfter === remoteImplementationBefore };
    } catch (error: any) {
        failure = String(error.shortMessage ?? error.message).split("\n")[0].replace(/https?:\/\/[^\s]+/g, "[RPC]");
        throw error;
    } finally {
        const report = { passed: !failure, failure, ...result, safety: { allowedWriteNetwork: "in-process hardhat", allowedWriteChainId: 31337, configuredPublicSigningNetworks: 0, privateKeysLoadedByConfigOrScript: false, upstreamGatewayReadOnly: true, upstreamBroadcastRequestsForwarded: 0, broadcastRejectionTestPassed: blockedMethods[0] === "eth_sendRawTransaction", blockedMethods, upstreamMethods, localWrites }, transactions };
        writeFileSync(join(output, "report.json"), json(report) + "\n");
        network.provider.request = originalRequest;
        gateway.closeAllConnections();
        await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
}
main().catch((error: any) => { console.error(String(error.shortMessage ?? error.message).split("\n")[0].replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
