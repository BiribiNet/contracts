import { artifacts, viem } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, formatUnits, parseAbi, keccak256, encodeAbiParameters, toHex, type Address, type Hex } from "viem";
import { createArbitrumFallbackPublicClient } from "./utils/hardhatRpcFailover";
import { ERC1967_IMPLEMENTATION_SLOT } from "./utils/proxyVerification";
import { Etherscan } from "@nomicfoundation/hardhat-verify/internal/etherscan";
import { vars } from "hardhat/config";
import { assertProtocolRoleHandoff } from "./utils/mainnetRelease";
import { USDC, LINK_TOKEN, UNISWAP_V2_FACTORY, UNISWAP_V2_ROUTER } from "./constants/arbitrumOne";

async function main() {
    const root = join(__dirname, "..", "deployments");
    const m = JSON.parse(readFileSync(join(root, "arbitrum-one.json"), "utf8"));
    const a = m.addresses;
    const pc = createArbitrumFallbackPublicClient();
    if (await pc.getChainId() !== 42161) throw new Error("Wrong audit chain");
    const blockNumber = await pc.getBlockNumber();
    const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
    const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) }); };
    const equal = (name: string, actual: string, expected: string) => check(name, actual.toLowerCase() === expected.toLowerCase(), { actual, expected });
    const readAddress = (address: Address, getter: string) => pc.readContract({ address,
        abi: parseAbi([`function ${getter}() view returns(address)`]), functionName: getter, blockNumber }) as Promise<Address>;
    const tokenAbi = parseAbi(["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function totalSupply() view returns(uint256)"]);
    const bal = (token: Address, owner: Address) => pc.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber });
    const libraryNames: Record<string, string> = { rouletteLib: "RouletteLib", rouletteBetLib: "RouletteBetLib", jackpotBatchLib: "JackpotBatchLib", roulettePayoutMulLib: "RoulettePayoutMulLib", rouletteExposureLib: "RouletteExposureLib", rouletteJackpotCollectLib: "RouletteJackpotCollectLib", roulettePayoutSweepLib: "RoulettePayoutSweepLib", rouletteLiabilityMathLib: "RouletteLiabilityMathLib", rouletteBetCodecLib: "RouletteBetCodecLib", rouletteUpkeepScanLib: "RouletteUpkeepScanLib" };
    const linked = Object.fromEntries(Object.entries(libraryNames).map(([key, name]) => [name, m.linkedLibraries[key]]));
    const deployments: Array<[string, Address]> = [
        ["BRBToken", a.brb], ["BRBReferal", a.brbReferal], ["MarketRegistry", a.registry],
        ["RouletteEngine", a.engineImplementation], ["ERC1967Proxy", a.engine],
        ["SideBet", a.sideBetImplementation], ["ERC1967Proxy", a.sideBet],
        ["SideBetChallengeEvaluator", a.challengeEvaluator], ["UpkeepScheduler", a.scheduler],
        ["CreExecutionAuthority", a.creExecutionAuthority], ["JackpotTreasury", a.jackpotTreasury],
        ["BRBJackpotFunder", a.jackpotFunder], ["TipJar", a.tipJar], ["BankVault4626", a.vaultImpl],
        ["UpgradeableBeacon", a.vaultBeacon], ["BeaconProxy", m.markets.brb.bank],
        ...Object.entries(linked).map(([name, address]) => [name, address as Address] as [string, Address]),
    ];
    for (const [name, address] of deployments) {
        const artifact = await artifacts.readArtifact(name);
        const info = await artifacts.getBuildInfo(name === "SideBetChallengeEvaluator" ? "contracts/SideBet.sol:SideBet" : `${artifact.sourceName}:${name}`);
        if (!info) throw new Error(`Missing compiler build for ${name}`);
        const runtime = info.output.contracts[artifact.sourceName][name].evm.deployedBytecode;
        const actual = await pc.getBytecode({ address, blockNumber });
        if (!actual || actual === "0x") { check(`runtime ${name} ${address}`, false, "No code"); continue; }
        let template = runtime.object.toLowerCase();
        let observed = actual.slice(2).toLowerCase();
        for (const refs of Object.values(artifact.deployedLinkReferences)) for (const [library, positions] of Object.entries(refs)) {
            if (!linked[library]) throw new Error(`Unknown production library ${library}`);
            for (const { start, length } of positions) template = template.slice(0, start * 2) + linked[library].slice(2).toLowerCase().padStart(length * 2, "0") + template.slice((start + length) * 2);
        }
        const immutableReferences = (runtime as typeof runtime & { immutableReferences?: Record<string, Array<{ start: number; length: number }>> }).immutableReferences ?? {};
        const variableNames: Record<string, string> = {};
        const walk = (node: any) => {
            if (!node || typeof node !== "object") return;
            if (node.nodeType === "VariableDeclaration") variableNames[node.id] = node.name;
            for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
        };
        Object.values(info.output.sources).forEach((source: any) => walk(source.ast));
        const shortString = (value: string) => "0x" + Buffer.from(value).toString("hex").padEnd(62, "0") + value.length.toString(16).padStart(2, "0");
        const immutableValues: Record<string, string | bigint> = {
            ROULETTE_ENGINE: a.engine, ENGINE: a.engine, SIDE_BET: a.sideBet, engine: a.engine,
            brb: a.brb, sideBet: a.sideBet, router: UNISWAP_V2_ROUTER, jackpotTreasury: a.jackpotTreasury,
            TOKEN: a.brb, RECIPIENT: m.infraWallet, __self: address, _beacon: a.vaultBeacon,
            BRB_REFERRAL: a.brbReferal, CHALLENGE_EVALUATOR: a.challengeEvaluator,
            VRF_KEY_HASH_2_GWEI: m.vrf.keyHash2Gwei, VRF_KEY_HASH_30_GWEI: m.vrf.keyHash30Gwei,
            VRF_KEY_HASH_150_GWEI: m.vrf.keyHash150Gwei, VRF_CONFIRMATIONS: BigInt(m.vrf.confirmations),
            _vrfCoordinator: m.vrf.coordinator, _cachedChainId: 42161n, _cachedThis: a.brb,
            _hashedName: keccak256(toHex("BIRIBI")), _hashedVersion: keccak256(toHex("1")),
            _name: shortString("BIRIBI"), _version: shortString("1"),
            _cachedDomainSeparator: keccak256(encodeAbiParameters([
                { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" },
            ], [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
                keccak256(toHex("BIRIBI")), keccak256(toHex("1")), 42161n, a.brb])),
        };
        for (const [id, positions] of Object.entries(immutableReferences)) {
            const variable = variableNames[id];
            const value = immutableValues[variable];
            if (value === undefined) throw new Error(`Unknown constructor immutable ${name}.${variable}`);
            const hex = (typeof value === "bigint" ? toHex(value) : value).slice(2).toLowerCase();
            for (const { start, length } of positions) template = template.slice(0, start * 2) + hex.padStart(length * 2, "0") + template.slice((start + length) * 2);
        }
        if (template.startsWith("73" + "0".repeat(40))) {
            equal(`library self address ${name}`, `0x${observed.slice(2, 42)}`, address);
            observed = observed.slice(0, 2) + "0".repeat(40) + observed.slice(42);
        }
        check(`runtime ${name} ${address}`, template === observed, { bytes: (actual.length - 2) / 2, deployedHash: keccak256(actual), constructorImmutableRanges: Object.values(immutableReferences).flat().length });
    }
    for (const [proxy, implementation] of [[a.engine, a.engineImplementation], [a.sideBet, a.sideBetImplementation]]) {
        const slot = await pc.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT, blockNumber });
        equal(`proxy implementation ${proxy}`, `0x${slot?.slice(-40)}`, implementation);
    }
    const beaconSlot = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;
    const slot = await pc.getStorageAt({ address: m.markets.brb.bank, slot: beaconSlot, blockNumber });
    equal("bank beacon", `0x${slot?.slice(-40)}`, a.vaultBeacon);
    for (const [address, getter, expected] of [
        [a.engine, "REGISTRY", a.registry], [a.engine, "JACKPOT_TREASURY", a.jackpotTreasury],
        [a.engine, "JACKPOT_FUNDER", a.jackpotFunder], [a.engine, "UPKEEP_SCHEDULER", a.scheduler],
        [a.engine, "INFRA_RECIPIENT", m.infraWallet], [a.engine, "BRB_REFERRAL", a.brbReferal],
        [a.registry, "ENGINE", a.engine], [a.registry, "SIDE_BET", a.sideBet], [a.registry, "vaultBeacon", a.vaultBeacon],
        [a.scheduler, "ENGINE", a.engine], [a.scheduler, "SIDE_BET", a.sideBet], [a.scheduler, "forwarderAuthority", a.creExecutionAuthority],
        [a.sideBet, "ENGINE", a.engine], [a.sideBet, "REGISTRY", a.registry], [a.sideBet, "CHALLENGE_EVALUATOR", a.challengeEvaluator],
        [a.jackpotTreasury, "engine", a.engine], [a.jackpotTreasury, "brb", a.brb],
        [a.jackpotFunder, "engine", a.engine], [a.jackpotFunder, "sideBet", a.sideBet], [a.jackpotFunder, "brb", a.brb],
        [a.jackpotFunder, "router", UNISWAP_V2_ROUTER], [a.jackpotFunder, "jackpotTreasury", a.jackpotTreasury],
        [a.tipJar, "TOKEN", a.brb], [a.tipJar, "RECIPIENT", m.infraWallet],
        [a.vaultBeacon, "implementation", a.vaultImpl], [a.vaultBeacon, "owner", m.protocolAdmin],
        [m.markets.brb.bank, "asset", a.brb], [m.markets.brb.bank, "ENGINE", a.engine],
    ] as Array<[Address, string, Address]>) equal(`${getter} at ${address}`, await readAddress(address, getter), expected);
    const engine = await viem.getContractAt("RouletteEngine", a.engine);
    const registry = await viem.getContractAt("MarketRegistry", a.registry);
    const sideBet = await viem.getContractAt("SideBet", a.sideBet);
    const authority = await viem.getContractAt("CreExecutionAuthority", a.creExecutionAuthority);
    const bank = await viem.getContractAt("BankVault4626", m.markets.brb.bank);
    check("BRB-only market", await registry.read.marketCount() === 1 && (await registry.read.getMarket([1])).bank.toLowerCase() === bank.address.toLowerCase());
    check("infra bank assets", await bank.read.totalAssets() === 300000n * 10n ** 18n);
    check("infra owns recorded shares", await bank.read.balanceOf([m.infraWallet]) === BigInt(m.infrastructureStake.shares));
    check("withdrawal fee 1 BRB", await bank.read.flatWithdrawFee() === 10n ** 18n);
    check("infrastructure profit fee 2%", await engine.read.INFRA_BPS() === 200n);
    check("VRF subscription configured", await engine.read.VRF_SUBSCRIPTION_ID() === BigInt(m.vrf.subscriptionId));
    check("VRF callback gas configured", await engine.read.VRF_CALLBACK_GAS_LIMIT() === m.vrf.callbackGasLimit);
    check("round duration configured", await engine.read.ROUND_DURATION() === 60);
    check("payout lanes configured", await engine.read.payoutParallelLaneCount() === 2);
    check("VRF confirmations configured", await engine.read.VRF_CONFIRMATIONS() === m.vrf.confirmations);
    for (const [getter, expected] of [["VRF_KEY_HASH_2_GWEI", m.vrf.keyHash2Gwei], ["VRF_KEY_HASH_30_GWEI", m.vrf.keyHash30Gwei], ["VRF_KEY_HASH_150_GWEI", m.vrf.keyHash150Gwei]] as Array<[string, string]>) {
        const actual = await pc.readContract({ address: a.engine, abi: parseAbi([`function ${getter}() view returns(bytes32)`]), functionName: getter, blockNumber }) as string;
        equal(getter, actual, expected);
    }
    const subscription = await pc.readContract({ address: m.vrf.coordinator, abi: parseAbi(["function getSubscription(uint256) view returns(uint96,uint96,uint64,address,address[])"]), functionName: "getSubscription", args: [BigInt(m.vrf.subscriptionId)], blockNumber });
    equal("VRF owner infrastructure", subscription[3], m.infraWallet);
    check("VRF funded with all deployer LINK", subscription[0] === BigInt(m.vrf.linkFundedFromDeployerJuels), subscription[0].toString());
    check("VRF engine consumer", subscription[4].some(x => x.toLowerCase() === a.engine.toLowerCase()));
    check("dedicated keeper approved", await authority.read.isApprovedAutomationForwarder([m.automation.keeper]));
    check("keeper has no admin role", !await authority.read.hasRole([await authority.read.DEFAULT_ADMIN_ROLE(), m.automation.keeper]));
    check("SideBet scheduler settlement role", await sideBet.read.hasRole([await sideBet.read.SETTLEMENT_ROLE(), a.scheduler]));
    const scheduler = await viem.getContractAt("UpkeepScheduler", a.scheduler);
    const treasury = await viem.getContractAt("JackpotTreasury", a.jackpotTreasury);
    const funder = await viem.getContractAt("BRBJackpotFunder", a.jackpotFunder);
    check("scheduler scan limit", await scheduler.read.scanLimit() === 25);
    check("scheduler payout batch", await scheduler.read.maxPayoutsPerCall() === 60);
    const roleHandoff = [
        { contract: scheduler, roles: ["DEFAULT_ADMIN_ROLE", "SCHEDULER_ADMIN_ROLE"], label: "scheduler" },
        { contract: treasury, roles: ["DEFAULT_ADMIN_ROLE", "TREASURY_ADMIN_ROLE"], label: "treasury" },
        { contract: funder, roles: ["DEFAULT_ADMIN_ROLE", "FUNDER_ADMIN_ROLE"], label: "funder" },
        { contract: bank, roles: ["DEFAULT_ADMIN_ROLE", "BANK_ADMIN_ROLE"], label: "bank" },
        { contract: engine, roles: ["DEFAULT_ADMIN_ROLE", "ENGINE_WITHDRAWAL_ROLE", "ENGINE_PAYOUT_ROLE", "ENGINE_ROUND_ROLE", "ENGINE_FEE_ROLE"], label: "engine" },
        { contract: sideBet, roles: ["DEFAULT_ADMIN_ROLE", "SIDE_BET_CONFIG_ROLE", "SIDE_BET_LIMITS_ROLE"], label: "SideBet" },
        { contract: registry, roles: ["DEFAULT_ADMIN_ROLE", "MARKET_FACTORY_ROLE"], label: "registry" },
        { contract: authority, roles: ["DEFAULT_ADMIN_ROLE", "EXECUTOR_ADMIN_ROLE"], label: "authority" },
    ];
    await assertProtocolRoleHandoff(roleHandoff, m.deployer, m.protocolAdmin);
    check("protocol administrator roles", true);
    const pair = await pc.readContract({ address: UNISWAP_V2_FACTORY, abi: parseAbi(["function getPair(address,address) view returns(address)"]), functionName: "getPair", args: [a.brb, USDC], blockNumber });
    equal("factory pair", pair, m.liquidity.pair);
    const pairAbi = parseAbi(["function token0() view returns(address)", "function token1() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)", "function totalSupply() view returns(uint256)"]);
    const token0 = await pc.readContract({ address: pair, abi: pairAbi, functionName: "token0", blockNumber });
    const token1 = await pc.readContract({ address: pair, abi: pairAbi, functionName: "token1", blockNumber });
    check("pool tokens BRB/USDC", [token0.toLowerCase(), token1.toLowerCase()].sort().join() === [a.brb.toLowerCase(), USDC.toLowerCase()].sort().join());
    const reserves = await pc.readContract({ address: pair, abi: pairAbi, functionName: "getReserves", blockNumber });
    const [brbReserve, usdcReserve] = token0.toLowerCase() === a.brb.toLowerCase() ? reserves : [reserves[1], reserves[0]];
    const lp = await bal(pair, m.deployer);
    const lpSupply = await pc.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply", blockNumber });
    check("pool reserves approved amounts", brbReserve === 2400000n * 10n ** 18n && usdcReserve === 24000n * 10n ** 6n);
    check("all minted LP stays with deployer", lp > 0n && lpSupply - lp === 1000n);
    for (const token of [a.brb, USDC]) check(`router allowance cleared ${token}`, await pc.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [m.deployer, UNISWAP_V2_ROUTER], blockNumber }) === 0n);
    const balances: Record<string, string> = {};
    for (const [name, address] of Object.entries({ deployer: m.deployer, infra: m.infraWallet, marketing: m.marketingWallet, houseBot: m.houseBotWallet, keeper: m.automation.keeper })) balances[`${name}Eth`] = formatEther(await pc.getBalance({ address: address as Address, blockNumber }));
    balances.deployerLink = formatUnits(await bal(LINK_TOKEN, m.deployer), 18);
    balances.deployerUsdc = formatUnits(await bal(USDC, m.deployer), 6);
    balances.deployerBrb = formatUnits(await bal(a.brb, m.deployer), 18);
    balances.marketingBrb = formatUnits(await bal(a.brb, m.marketingWallet), 18);
    balances.houseBotBrb = formatUnits(await bal(a.brb, m.houseBotWallet), 18);
    check("marketing 299000 BRB", balances.marketingBrb === "299000");
    check("house bot 1000 BRB", balances.houseBotBrb === "1000");
    check("deployer LINK fully transferred", balances.deployerLink === "0");
    const receipts = [];
    for (const line of readFileSync(join(root, "arbitrum-one-liquidity-transactions.jsonl"), "utf8").trim().split("\n")) {
        const record = JSON.parse(line);
        if (record.event !== "broadcast") continue;
        const [receipt, transaction] = await Promise.all([pc.getTransactionReceipt({ hash: record.hash }), pc.getTransaction({ hash: record.hash })]);
        check(`pool transaction ${record.hash}`, receipt.status === "success");
        equal(`pool sender ${record.hash}`, transaction.from, m.deployer);
        receipts.push({ hash: record.hash, to: transaction.to, status: receipt.status, blockNumber: receipt.blockNumber.toString() });
    }
    const health = await fetch(`${m.automation.workerUrl}/health`, { signal: AbortSignal.timeout(15_000) });
    const worker = await health.json();
    check("Cloudflare worker healthy", health.ok && (worker as { ok?: boolean }).ok === true);
    const explorer = new Etherscan(vars.get("ETHERSCAN_API_KEY"), "https://api.etherscan.io/v2/api", "https://arbiscan.io", 42161);
    const poolSourceVerified = await explorer.isVerified(pair);
    check("Uniswap pool source publicly verified", poolSourceVerified);
    const failed = checks.filter(x => !x.ok);
    const report = { checkedAt: new Date().toISOString(), chainId: 42161, blockNumber: blockNumber.toString(), ok: failed.length === 0, checks, balances,
        pool: { address: pair, sourceVerified: poolSourceVerified, brbReserve: formatUnits(brbReserve, 18), usdcReserve: formatUnits(usdcReserve, 6), lpOwner: m.deployer, lpBalance: lp.toString(), lpSupply: lpSupply.toString(), standardMinimumLiquidityBurned: "1000", lpVestingLockDeployed: false, receipts },
        vrf: { owner: subscription[3], linkBalance: formatUnits(subscription[0], 18), consumers: subscription[4] }, worker,
        scope: "Read-only exact runtime comparison with expected constructor immutables and library addresses reconstructed, proxy storage, wiring, ownership, funding and receipt audit. Explorer source verification is tracked separately." };
    writeFileSync(join(root, "arbitrum-one-onchain-audit.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ok: report.ok, checks: checks.length, failed, balances, pool: report.pool, vrf: report.vrf, worker }, null, 2));
    if (failed.length) process.exitCode = 1;
}
main().catch(() => { console.error("Read-only deployment audit interrupted; no transaction was sent. Inspect completed audit checks and source getter definitions."); process.exitCode = 1; });
