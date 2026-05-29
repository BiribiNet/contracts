import "dotenv/config";

import hre from "hardhat";
import { vars } from "hardhat/config";
import { viem } from "hardhat";
import { parseAbi } from "viem";

import { verifyContractWithDelay, verifyRouletteEngineImplementation } from "./utils/verifyWithEtherscan";

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

const ERC1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const DEFAULT_LINK = "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E" as const;
const DEFAULT_VRF_COORDINATOR = "0x50d47e4142598E3411aA864e08a44284e471AC6f" as const;
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

type LinkedLibs = {
    rouletteLib: `0x${string}`;
    rouletteBetLib: `0x${string}`;
    jackpotBatchLib: `0x${string}`;
    roulettePayoutMulLib: `0x${string}`;
    rouletteLiabilityMathLib: `0x${string}`;
    rouletteBetCodecLib: `0x${string}`;
    roulettePayoutSweepLib: `0x${string}`;
    rouletteJackpotCollectLib: `0x${string}`;
    rouletteExposureLib: `0x${string}`;
    rouletteUpkeepScanLib: `0x${string}`;
};

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
    linkedLibraries?: LinkedLibs;
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

async function discoverLibrariesFromExplorer(
    deployer: `0x${string}`,
    engine: `0x${string}`,
): Promise<LinkedLibs> {
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
    const eng = engine.toLowerCase();
    const eIdx = creates.findIndex((t) => t.contractAddress.toLowerCase() === eng);
    if (eIdx === -1) {
        throw new Error(
            "Could not find engine contract creation in Etherscan txlist; paste linkedLibraries into VERIFY_DEPLOYMENT_JSON or increase script offset.",
        );
    }
    const pick = (i: number) => creates[i]?.contractAddress as `0x${string}`;
    return {
        rouletteBetCodecLib: pick(eIdx + 1),
        rouletteLiabilityMathLib: pick(eIdx + 2),
        roulettePayoutMulLib: pick(eIdx + 3),
        jackpotBatchLib: pick(eIdx + 4),
        rouletteBetLib: pick(eIdx + 5),
        rouletteLib: pick(eIdx + 6),
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

    const implSlot = await publicClient.getStorageAt({ address: d.engine, slot: ERC1967_IMPLEMENTATION_SLOT });
    const engineImplementation = (`0x${implSlot.slice(-40)}`) as `0x${string}`;

    const engineAbi = parseAbi([
        "function REGISTRY() view returns (address)",
        "function VRF_COORDINATOR() view returns (address)",
        "function JACKPOT_TREASURY() view returns (address)",
        "function JACKPOT_FUNDER() view returns (address)",
        "function INFRA_RECIPIENT() view returns (address)",
        "function VRF_SUBSCRIPTION_ID() view returns (uint256)",
        "function VRF_KEY_HASH_2_GWEI() view returns (bytes32)",
        "function VRF_KEY_HASH_30_GWEI() view returns (bytes32)",
        "function VRF_KEY_HASH_150_GWEI() view returns (bytes32)",
        "function VRF_CALLBACK_GAS_LIMIT() view returns (uint32)",
        "function VRF_CONFIRMATIONS() view returns (uint16)",
        "function ROUND_DURATION() view returns (uint32)",
        "function hasRole(bytes32 role, address account) view returns (bool)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
        "function UPKEEP_SCHEDULER() view returns (address)",
    ]);

    const [
        regOnChain,
        treasuryOnChain,
        funderOnChain,
        infraOnChain,
        vrfCoordOnChain,
        vrfSubId,
        kh2,
        kh30,
        kh150,
        cbGas,
        vrfConf,
        roundDur,
        adminHasDefaultRole,
        schedOnChain,
    ] = await Promise.all([
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "REGISTRY" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "JACKPOT_TREASURY" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "JACKPOT_FUNDER" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "INFRA_RECIPIENT" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_COORDINATOR" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_SUBSCRIPTION_ID" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_KEY_HASH_2_GWEI" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_KEY_HASH_30_GWEI" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_KEY_HASH_150_GWEI" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_CALLBACK_GAS_LIMIT" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "VRF_CONFIRMATIONS" }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "ROUND_DURATION" }),
        publicClient.readContract({
            address: d.engine,
            abi: engineAbi,
            functionName: "hasRole",
            args: [
                await publicClient.readContract({
                    address: d.engine,
                    abi: engineAbi,
                    functionName: "DEFAULT_ADMIN_ROLE",
                }),
                d.admin,
            ],
        }),
        publicClient.readContract({ address: d.engine, abi: engineAbi, functionName: "UPKEEP_SCHEDULER" }),
    ]);

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

    const linked: LinkedLibs = d.linkedLibraries ?? (await discoverLibrariesFromExplorer(d.deployer, d.engine));

    console.log("Verifying core protocol…");
    await verifyContractWithDelay(d.brb, [d.deployer], verifyDelayMs);
    await verifyContractWithDelay(d.dai, [], verifyDelayMs);
    await verifyContractWithDelay(d.jackpotTreasury, [d.brb, d.deployer], verifyDelayMs);
    await verifyContractWithDelay(
        d.jackpotFunder,
        ["0x0000000000000000000000000000000000000000", d.brb, d.router, d.jackpotTreasury, d.deployer],
        verifyDelayMs,
    );
    await verifyContractWithDelay(d.registry, [d.deployer], verifyDelayMs);
    await verifyContractWithDelay(vaultImplAddr, [], verifyDelayMs);
    await verifyContractWithDelay(beaconAddr, [vaultImplAddr, d.deployer], verifyDelayMs);

    await verifyContractWithDelay(linked.rouletteLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteBetLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.jackpotBatchLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.roulettePayoutMulLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteLiabilityMathLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteBetCodecLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.roulettePayoutSweepLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteJackpotCollectLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteExposureLib, [], verifyDelayMs);
    await verifyContractWithDelay(linked.rouletteUpkeepScanLib, [], verifyDelayMs);

    const libraryMap: Record<string, string> = {
        "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": linked.jackpotBatchLib,
        "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib": linked.rouletteBetCodecLib,
        "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib": linked.rouletteExposureLib,
        "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib": linked.rouletteJackpotCollectLib,
        "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib": linked.rouletteLiabilityMathLib,
        "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": linked.roulettePayoutSweepLib,
        "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib": linked.rouletteUpkeepScanLib,
    };
    await verifyRouletteEngineImplementation(engineImplementation, vrfCoordOnChain, libraryMap, verifyDelayMs);

    await verifyContractWithDelay(d.scheduler, [d.engine, d.deployer, 25, 60], verifyDelayMs);
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
