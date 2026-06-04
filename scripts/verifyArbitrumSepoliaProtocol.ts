import "dotenv/config";

import hre from "hardhat";
import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { parseAbi } from "viem";

import {
    encodeBankVaultProxyInitDataFromBank,
    encodeEngineProxyInitData,
    encodeSideBetProxyInitData,
    readErc1967Implementation,
    verifyProtocolProxies,
} from "./utils/proxyVerification";
import {
    buildRouletteEngineLibraryMap,
    type RouletteLinkedLibraries,
    verifyContractWithDelay,
    verifyRouletteLinkedLibraries,
    verifyUpgradeableBeaconWithDelay,
} from "./utils/verifyWithEtherscan";

/**
 * Re-verify a protocol deployment on Arbitrum Sepolia (421614) on Arbiscan.
 *
 * Prerequisites: `hardhat vars set ETHERSCAN_API_KEY` (Etherscan.io unified key for API v2).
 *
 * Configuration:
 * - `VERIFY_DEPLOYMENT_JSON` — optional JSON string; defaults to the last known session deploy if unset.
 *   Shape: { deployer, brb, dai, router, jackpotTreasury, jackpotFunder, registry, engine, scheduler, upkeepManager,
 *            linkedLibraries? }
 * - `VERIFY_UNISWAP_JSON` — optional `{"factory":"0x…","weth":"0x…","router":"0x…"}` for locally deployed Uniswap V2.
 * - `VERIFY_DELAY_MS` — delay between Arbiscan calls (default 8000).
 */

const FQ_UNISWAP_FACTORY = "contracts/vendor/uniswap-v2-core/UniswapV2Factory.sol:UniswapV2Factory" as const;
const FQ_WETH9 = "contracts/vendor/uniswap-v2-periphery/test/WETH9.sol:WETH9" as const;
const FQ_UNISWAP_ROUTER = "contracts/vendor/uniswap-v2-periphery/UniswapV2Router02.sol:UniswapV2Router02" as const;

const DEFAULT_LINK = "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E" as const;
/** Matches `deployProtocolArbitrumSepolia.ts` default. */
const DEFAULT_VRF_COORDINATOR = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as const;
const DEFAULT_KEEPER_REGISTRY = "0x8194399B3f11fcA2E8cCEfc4c9A658c61B8Bf412" as const;
const DEFAULT_KEEPER_REGISTRAR = "0x881918E24290084409DaA91979A30e6f0dB52eBe" as const;

/** Last full deploy from this repo session (override with VERIFY_DEPLOYMENT_JSON). */
const DEFAULT_DEPLOYMENT = {
    deployer: "0xbbbbedc42dc53842141be8f70df9efe4d08538a4",
    brb: "0x47e054bb133e75b1c2c7a9a52ba73e52e75a06a1",
    dai: "0xb74d2094d55e5eedeb4dee743cbe17f38a20285d",
    router: "0xc84202ebc1630f8aaaced74f0e07856e2f6f4570",
    jackpotTreasury: "0xbbe4d51cf721277d52d916291f6de4fa972e5e22",
    jackpotFunder: "0x60ce672feaf39f35a3f6e5b3e099f46b90aee9fc",
    registry: "0x9a328b11c7189a8ba2af6186643f93204b516987",
    engine: "0x60cd5a0f74f1644eaef997496e19e3737690ad1c",
    scheduler: "0x40a7f6d4e902f13e2d9e4754dee37648f2fcdfda",
    upkeepManager: "0xdbfab262996d221c72eeb9f2e6679c3d2c7bc95b",
} as const;

type Deployment = {
    deployer: `0x${string}`;
    brb: `0x${string}`;
    dai: `0x${string}`;
    router: `0x${string}`;
    jackpotTreasury: `0x${string}`;
    jackpotFunder: `0x${string}`;
    registry: `0x${string}`;
    engine: `0x${string}`;
    scheduler: `0x${string}`;
    upkeepManager: `0x${string}`;
    /** Omit to read `SIDE_BET()` from registry. */
    sideBet?: `0x${string}`;
    /** Omit to read `BRB_REFERRAL()` from engine implementation. */
    brbReferral?: `0x${string}`;
    /** Omit to discover banks via `registry.getMarket(1..marketCount)`. */
    banks?: readonly `0x${string}`[];
    linkedLibraries?: RouletteLinkedLibraries;
};

type TxRow = { contractAddress: string; to: string };

function loadDeployment(): Deployment {
    const raw = process.env.VERIFY_DEPLOYMENT_JSON?.trim();
    if (raw) {
        return JSON.parse(raw) as Deployment;
    }
    return { ...DEFAULT_DEPLOYMENT };
}

function envBigIntOr(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    return BigInt(raw);
}

/**
 * Walk deployer CREATE txs older than the engine implementation (newest-first list).
 * Assumes `BRBReferal` was deployed immediately before the implementation (this repo's default).
 */
async function discoverLibrariesFromExplorer(
    deployer: `0x${string}`,
    engineImplementation: `0x${string}`,
): Promise<RouletteLinkedLibraries> {
    const apiKey = vars.get("ETHERSCAN_API_KEY");
    const params = new URLSearchParams({
        chainid: "421614",
        module: "account",
        action: "txlist",
        address: deployer,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: "400",
        sort: "desc",
        apikey: apiKey,
    });
    const res = await fetch(`https://api.etherscan.io/v2/api?${params.toString()}`);
    const json = (await res.json()) as { status: string; message: string; result: TxRow[] | string };
    if (json.status !== "1" || !Array.isArray(json.result)) {
        throw new Error(`Etherscan txlist failed: ${json.message} — ${typeof json.result === "string" ? json.result : ""}`);
    }
    const creates = json.result.filter((t) => t.to === "" && t.contractAddress);
    const eng = engineImplementation.toLowerCase();
    const eIdx = creates.findIndex((t) => t.contractAddress.toLowerCase() === eng);
    if (eIdx === -1) {
        throw new Error(
            "Could not find RouletteEngine implementation in Etherscan txlist; paste linkedLibraries into VERIFY_DEPLOYMENT_JSON.",
        );
    }
    const pick = (i: number) => {
        const addr = creates[i]?.contractAddress;
        if (!addr) {
            throw new Error(`Missing CREATE at txlist index ${i}; paste linkedLibraries into VERIFY_DEPLOYMENT_JSON.`);
        }
        return addr as `0x${string}`;
    };
    const libBase = eIdx + 2;
    return {
        rouletteBetCodecLib: pick(libBase),
        rouletteLiabilityMathLib: pick(libBase + 1),
        roulettePayoutSweepLib: pick(libBase + 2),
        rouletteJackpotCollectLib: pick(libBase + 3),
        rouletteUpkeepScanLib: pick(libBase + 4),
        rouletteExposureLib: pick(libBase + 5),
        roulettePayoutMulLib: pick(libBase + 6),
        jackpotBatchLib: pick(libBase + 7),
        rouletteBetLib: pick(libBase + 8),
        rouletteLib: pick(libBase + 9),
    };
}

async function main() {
    if (!vars.has("ETHERSCAN_API_KEY")) {
        throw new Error("Set `hardhat vars set ETHERSCAN_API_KEY` (Etherscan.io API key for v2).");
    }

    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();
    if (chainId !== 421614) {
        throw new Error(`This script expects Arbitrum Sepolia (421614); got ${chainId}`);
    }

    const d = loadDeployment();
    const verifyDelayMs = Number(envBigIntOr("VERIFY_DELAY_MS", 8000n));
    const linkToken = (process.env.LINK_TOKEN as `0x${string}` | undefined) ?? DEFAULT_LINK;
    const keeperRegistrar = (process.env.KEEPER_REGISTRAR as `0x${string}` | undefined) ?? DEFAULT_KEEPER_REGISTRAR;
    const keeperRegistry = (process.env.KEEPER_REGISTRY as `0x${string}` | undefined) ?? DEFAULT_KEEPER_REGISTRY;

    const uniswapRaw = process.env.VERIFY_UNISWAP_JSON?.trim();
    if (uniswapRaw) {
        const u = JSON.parse(uniswapRaw) as { factory: `0x${string}`; weth: `0x${string}`; router: `0x${string}` };
        console.log("Verifying Uniswap V2 trio…");
        await verifyContractWithDelay(u.factory, [d.deployer], verifyDelayMs, FQ_UNISWAP_FACTORY);
        await verifyContractWithDelay(u.weth, [], verifyDelayMs, FQ_WETH9);
        await verifyContractWithDelay(u.router, [u.factory, u.weth], verifyDelayMs, FQ_UNISWAP_ROUTER);
    }

    const engineProxyAbi = parseAbi([
        "function REGISTRY() view returns (address)",
        "function JACKPOT_TREASURY() view returns (address)",
        "function JACKPOT_FUNDER() view returns (address)",
        "function INFRA_RECIPIENT() view returns (address)",
        "function VRF_SUBSCRIPTION_ID() view returns (uint256)",
        "function VRF_CALLBACK_GAS_LIMIT() view returns (uint32)",
        "function ROUND_DURATION() view returns (uint32)",
        "function hasRole(bytes32 role, address account) view returns (bool)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
        "function UPKEEP_SCHEDULER() view returns (address)",
    ]);
    const vrfCoordinatorForVerify =
        (process.env.VRF_COORDINATOR as `0x${string}` | undefined) ?? DEFAULT_VRF_COORDINATOR;

    const engineImplAbi = parseAbi([
        "function VRF_KEY_HASH_2_GWEI() view returns (bytes32)",
        "function VRF_KEY_HASH_30_GWEI() view returns (bytes32)",
        "function VRF_KEY_HASH_150_GWEI() view returns (bytes32)",
        "function VRF_CONFIRMATIONS() view returns (uint16)",
        "function BRB_REFERRAL() view returns (address)",
    ]);

    const engineImplementation = await readErc1967Implementation(publicClient, d.engine);

    const [
        regOnChain,
        treasuryOnChain,
        funderOnChain,
        infraOnChain,
        vrfSubId,
        cbGas,
        roundDur,
        adminHasDefaultRole,
        schedOnChain,
        kh2,
        kh30,
        kh150,
        vrfConf,
    ] = await Promise.all([
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "REGISTRY" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "JACKPOT_TREASURY" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "JACKPOT_FUNDER" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "INFRA_RECIPIENT" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "VRF_SUBSCRIPTION_ID" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "VRF_CALLBACK_GAS_LIMIT" }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "ROUND_DURATION" }),
        publicClient.readContract({
            address: d.engine,
            abi: engineProxyAbi,
            functionName: "hasRole",
            args: [
                await publicClient.readContract({
                    address: d.engine,
                    abi: engineProxyAbi,
                    functionName: "DEFAULT_ADMIN_ROLE",
                }),
                d.deployer,
            ],
        }),
        publicClient.readContract({ address: d.engine, abi: engineProxyAbi, functionName: "UPKEEP_SCHEDULER" }),
        publicClient.readContract({ address: engineImplementation, abi: engineImplAbi, functionName: "VRF_KEY_HASH_2_GWEI" }),
        publicClient.readContract({ address: engineImplementation, abi: engineImplAbi, functionName: "VRF_KEY_HASH_30_GWEI" }),
        publicClient.readContract({ address: engineImplementation, abi: engineImplAbi, functionName: "VRF_KEY_HASH_150_GWEI" }),
        publicClient.readContract({ address: engineImplementation, abi: engineImplAbi, functionName: "VRF_CONFIRMATIONS" }),
    ]);

    const registryImmutableAbi = parseAbi([
        "function ENGINE() view returns (address)",
        "function SIDE_BET() view returns (address)",
    ]);
    const sideBetAddr =
        d.sideBet ??
        (await publicClient.readContract({
            address: d.registry,
            abi: registryImmutableAbi,
            functionName: "SIDE_BET",
        }));

    const sideBetImplementation = await readErc1967Implementation(publicClient, sideBetAddr);

    const norm = (a: string) => a.toLowerCase();
    if (norm(regOnChain) !== norm(d.registry)) throw new Error("Engine REGISTRY mismatch vs VERIFY_DEPLOYMENT_JSON");
    if (norm(treasuryOnChain) !== norm(d.jackpotTreasury)) throw new Error("Engine JACKPOT_TREASURY mismatch");
    if (norm(funderOnChain) !== norm(d.jackpotFunder)) throw new Error("Engine JACKPOT_FUNDER mismatch");
    if (norm(schedOnChain) !== norm(d.scheduler)) throw new Error("Engine UPKEEP_SCHEDULER mismatch");
    if (!adminHasDefaultRole) throw new Error("Engine deployer admin lacks DEFAULT_ADMIN_ROLE");

    const beaconAbi = parseAbi(["function implementation() view returns (address)", "function owner() view returns (address)"]);
    const registryAbi = parseAbi(["function vaultBeacon() view returns (address)"]);
    const beaconAddr = await publicClient.readContract({
        address: d.registry,
        abi: registryAbi,
        functionName: "vaultBeacon",
    });
    const vaultImplAddr = await publicClient.readContract({
        address: beaconAddr,
        abi: beaconAbi,
        functionName: "implementation",
    });

    const linked: RouletteLinkedLibraries =
        d.linkedLibraries ?? (await discoverLibrariesFromExplorer(d.deployer, engineImplementation));

    const brbReferralAddr =
        d.brbReferral ??
        (await publicClient.readContract({
            address: engineImplementation,
            abi: engineImplAbi,
            functionName: "BRB_REFERRAL",
        }));

    const schedulerAbi = parseAbi([
        "function scanLimit() view returns (uint32)",
        "function maxPayoutsPerCall() view returns (uint32)",
    ]);
    const [scanLimit, maxPayoutsPerCall] = await Promise.all([
        publicClient.readContract({ address: d.scheduler, abi: schedulerAbi, functionName: "scanLimit" }),
        publicClient.readContract({ address: d.scheduler, abi: schedulerAbi, functionName: "maxPayoutsPerCall" }),
    ]);

    console.log("Verifying core protocol…");
    await verifyContractWithDelay(d.brb, [d.deployer], verifyDelayMs);
    await verifyContractWithDelay(d.dai, [], verifyDelayMs);
    if (brbReferralAddr !== "0x0000000000000000000000000000000000000000") {
        await verifyContractWithDelay(brbReferralAddr, [d.engine], verifyDelayMs);
    }
    await verifyContractWithDelay(d.jackpotTreasury, [d.brb, d.engine, d.deployer], verifyDelayMs);
    await verifyContractWithDelay(
        d.jackpotFunder,
        [d.engine, d.brb, d.router, d.jackpotTreasury, sideBetAddr, d.deployer],
        verifyDelayMs,
    );
    await verifyContractWithDelay(d.registry, [d.deployer, d.engine, sideBetAddr], verifyDelayMs);
    await verifyContractWithDelay(vaultImplAddr, [], verifyDelayMs);
    await verifyUpgradeableBeaconWithDelay(beaconAddr, [vaultImplAddr, d.deployer], verifyDelayMs);

    await verifyRouletteLinkedLibraries(linked, verifyDelayMs);

    const engineInitData = encodeEngineProxyInitData({
        registry: regOnChain,
        jackpotTreasury: treasuryOnChain,
        jackpotFunder: funderOnChain,
        infraRecipient: infraOnChain,
        subscriptionId: vrfSubId,
        callbackGasLimit: cbGas,
        roundDuration: roundDur,
        admin: d.deployer,
        upkeepScheduler: schedOnChain,
    });

    const sideBetReadAbi = parseAbi([
        "function ENGINE() view returns (address)",
        "function REGISTRY() view returns (address)",
        "function minMultiplierBps() view returns (uint32)",
        "function maxMultiplierBps() view returns (uint32)",
    ]);
    const [sbMinBps, sbMaxBps] = await Promise.all([
        publicClient.readContract({ address: sideBetAddr, abi: sideBetReadAbi, functionName: "minMultiplierBps" }),
        publicClient.readContract({ address: sideBetAddr, abi: sideBetReadAbi, functionName: "maxMultiplierBps" }),
    ]);
    const sideBetInitData = encodeSideBetProxyInitData(
        d.deployer,
        d.engine,
        regOnChain,
        sbMinBps,
        sbMaxBps,
    );

    const registryMarketAbi = parseAbi([
        "function marketCount() view returns (uint32)",
        "function getMarket(uint32 marketId) view returns ((address asset, address bank))",
    ]);
    let bankAddresses: readonly `0x${string}`[] = d.banks ?? [];
    if (bankAddresses.length === 0) {
        const marketCount = Number(
            await publicClient.readContract({
                address: d.registry,
                abi: registryMarketAbi,
                functionName: "marketCount",
            }),
        );
        const discovered: `0x${string}`[] = [];
        for (let marketId = 1; marketId <= marketCount; marketId++) {
            const market = await publicClient.readContract({
                address: d.registry,
                abi: registryMarketAbi,
                functionName: "getMarket",
                args: [marketId],
            });
            discovered.push((market as { asset: `0x${string}`; bank: `0x${string}` }).bank);
        }
        bankAddresses = discovered;
    }

    const bankVaults = await Promise.all(
        bankAddresses.map(async (bank) => ({
            bank,
            initData: await encodeBankVaultProxyInitDataFromBank(publicClient, bank, d.deployer),
        })),
    );

    console.log("Verifying proxies (ERC1967 engine/side-bet, beacon bank vaults)…");
    await verifyProtocolProxies({
        delayMs: verifyDelayMs,
        engineProxy: d.engine,
        engineImplementation,
        engineInitData,
        engineImplCtorArgs: [vrfCoordinatorForVerify, kh2, kh30, kh150, vrfConf, brbReferralAddr],
        engineLibraryMap: buildRouletteEngineLibraryMap(linked),
        sideBetProxy: sideBetAddr,
        sideBetImplementation,
        sideBetInitData,
        vaultBeacon: beaconAddr,
        bankVaults,
    });

    await verifyContractWithDelay(
        d.scheduler,
        [d.engine, sideBetAddr, d.deployer, scanLimit, maxPayoutsPerCall],
        verifyDelayMs,
    );
    await verifyContractWithDelay(
        d.upkeepManager,
        [linkToken, keeperRegistrar, keeperRegistry, d.scheduler, d.deployer, d.deployer],
        verifyDelayMs,
    );

    console.log("Verification finished.");
    console.log(
        JSON.stringify(
            {
                engine: d.engine,
                scheduler: d.scheduler,
                linkedLibraries: linked,
                vaultImpl: vaultImplAddr,
                vaultBeacon: beaconAddr,
            },
            null,
            2,
        ),
    );
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
