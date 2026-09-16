/**
 * Redeploy `UpkeepScheduler` on Arbitrum Sepolia after SideBet ABI drift broke `checkUpkeep`.
 *
 * Root cause: SideBet proxy was upgraded so `SettleRow` includes `expired`, but the non-upgradeable
 * scheduler still ABI-decoded the old 3-field struct → `checkUpkeep` reverted whenever it fell
 * through to `previewSettleBundle` (lane 1 always; lane 0 after VRF when no roulette job).
 *
 * Steps:
 * 1. UUPS-upgrade RouletteEngine (adds `setUpkeepScheduler`)
 * 2. Deploy a new UpkeepScheduler compiled against the current ISideBet
 * 3. Wire forwarder authority, engine pointer, SideBet SETTLEMENT_ROLE, AutomationReceiver allowlist
 * 4. Refresh CRE lane/HTTP configs + subgraph deployment JSON
 *
 * Prerequisites: BRB_KEY (engine + sideBet + receiver admin), ARBITRUM_SEPOLIA_RPC_URL, yarn compile
 *
 * Run: `yarn redeploy:scheduler:arbitrum-sepolia`
 */
import "dotenv/config";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import hre, { viem } from "hardhat";
import {
    getAddress,
    isAddress,
    keccak256,
    parseAbi,
    toBytes,
    toFunctionSelector,
    zeroHash,
    type Address,
    type Hex,
} from "viem";

import { deployRouletteEngineLibraries } from "./utils/deployRouletteEngineLibraries";
import {
    buildRouletteEngineLibraryMap,
    verifyContractWithDelay,
    verifyRouletteLinkedLibraries,
} from "./utils/verifyWithEtherscan";
import { writeCreHttpConfigs, writeCreWorkflowConfigs } from "./utils/writeCreWorkflowConfigs";

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const ERC1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");
const FQ_ROULETTE_ENGINE = "contracts/RouletteEngine.sol:RouletteEngine" as const;
const FQ_UPKEEP_SCHEDULER = "contracts/UpkeepScheduler.sol:UpkeepScheduler" as const;

const PERFORM_UPKEEP_SELECTOR = toFunctionSelector("performUpkeep(bytes)");
const SETTLEMENT_ROLE = keccak256(toBytes("SETTLEMENT_ROLE"));
const VRF_V25_SELECTOR = keccak256(toBytes("requestRandomWords((bytes32,uint256,uint16,uint32,uint32,bytes))")).slice(
    0,
    10,
);

const DEFAULT_VRF_COORDINATOR = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as const;
const DEFAULT_HTTP_AUTHORIZED = "0xbbbbeDc42dC53842141Be8F70Df9EFe4d08538A4" as const;

const implReadAbi = parseAbi([
    "function VRF_KEY_HASH_2_GWEI() view returns (bytes32)",
    "function VRF_KEY_HASH_30_GWEI() view returns (bytes32)",
    "function VRF_KEY_HASH_150_GWEI() view returns (bytes32)",
    "function VRF_CONFIRMATIONS() view returns (uint16)",
    "function BRB_REFERRAL() view returns (address)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
]);

const engineAbi = parseAbi([
    "function UPKEEP_SCHEDULER() view returns (address)",
    "function setUpkeepScheduler(address newScheduler)",
    "function payoutParallelLaneCount() view returns (uint32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
]);

const schedulerAbi = parseAbi([
    "function ENGINE() view returns (address)",
    "function SIDE_BET() view returns (address)",
    "function scanLimit() view returns (uint32)",
    "function maxPayoutsPerCall() view returns (uint32)",
    "function setForwarderAuthority(address newAuthority)",
    "function forwarderAuthority() view returns (address)",
    "function checkUpkeep(bytes checkData) view returns (bool upkeepNeeded, bytes performData)",
]);

const sideBetAbi = parseAbi([
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function grantRole(bytes32 role, address account)",
    "function revokeRole(bytes32 role, address account)",
]);

const receiverAbi = parseAbi([
    "function setCallAllowed(address target, bytes4 selector, bool allowed)",
    "function isCallAllowed(address target, bytes4 selector) view returns (bool)",
    "function owner() view returns (address)",
]);

function envAddress(name: string, fallback?: `0x${string}`): `0x${string}` {
    const raw = process.env[name]?.trim();
    if (!raw) {
        if (fallback) return fallback;
        throw new Error(`Missing required address env ${name}`);
    }
    if (!isAddress(raw)) throw new Error(`${name} must be a valid address: ${raw}`);
    return getAddress(raw);
}

function envBool(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return defaultValue;
    if (raw === "1" || raw === "true" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "no") return false;
    throw new Error(`${name} must be true/false`);
}

async function readErc1967Implementation(
    publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>,
    proxy: `0x${string}`,
) {
    const raw = await publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT });
    return getAddress(`0x${raw!.slice(-40)}`);
}

async function main() {
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got chainId ${chainId}`);
    }

    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8")) as {
        addresses: Record<string, string | string[]>;
        [k: string]: unknown;
    };

    const engineProxy = envAddress("ENGINE_PROXY", deploy.addresses.roulette as `0x${string}`);
    const oldScheduler = envAddress("OLD_SCHEDULER", deploy.addresses.scheduler as `0x${string}`);
    const sideBet = envAddress("SIDE_BET_PROXY", deploy.addresses.sideBet as `0x${string}`);
    const automationReceiver = envAddress(
        "AUTOMATION_RECEIVER",
        deploy.addresses.automationReceiver as `0x${string}`,
    );
    const creExecutionAuthority = envAddress(
        "CRE_EXECUTION_AUTHORITY",
        deploy.addresses.creExecutionAuthority as `0x${string}`,
    );
    const vrfCoordinator = envAddress("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);
    const httpAuthorized = envAddress("CRE_HTTP_AUTHORIZED_ADDRESS", DEFAULT_HTTP_AUTHORIZED);

    const [scanLimit, maxPayoutsPerCall, currentEngineScheduler, payoutLanes] = await Promise.all([
        publicClient.readContract({ address: oldScheduler, abi: schedulerAbi, functionName: "scanLimit" }),
        publicClient.readContract({ address: oldScheduler, abi: schedulerAbi, functionName: "maxPayoutsPerCall" }),
        publicClient.readContract({ address: engineProxy, abi: engineAbi, functionName: "UPKEEP_SCHEDULER" }),
        publicClient.readContract({ address: engineProxy, abi: engineAbi, functionName: "payoutParallelLaneCount" }),
    ]);

    console.log(
        JSON.stringify(
            {
                engineProxy,
                oldScheduler,
                currentEngineScheduler,
                sideBet,
                automationReceiver,
                creExecutionAuthority,
                scanLimit: Number(scanLimit),
                maxPayoutsPerCall: Number(maxPayoutsPerCall),
                payoutLanes: Number(payoutLanes),
            },
            null,
            2,
        ),
    );

    if (currentEngineScheduler.toLowerCase() !== oldScheduler.toLowerCase()) {
        console.warn(
            `Warning: engine.UPKEEP_SCHEDULER (${currentEngineScheduler}) != OLD_SCHEDULER (${oldScheduler})`,
        );
    }

    const isEngineAdmin = await publicClient.readContract({
        address: engineProxy,
        abi: engineAbi,
        functionName: "hasRole",
        args: [zeroHash, deployer.account.address],
    });
    if (!isEngineAdmin) {
        throw new Error(`Deployer ${deployer.account.address} lacks DEFAULT_ADMIN_ROLE on engine`);
    }

    // ─── 1. Upgrade engine (setUpkeepScheduler) ─────────────────────────────
    const previousImplementation = await readErc1967Implementation(publicClient, engineProxy);
    console.log("Current engine implementation:", previousImplementation);

    const [key2, key30, key150, confirmations, brbReferral] = await Promise.all([
        publicClient.readContract({
            address: previousImplementation,
            abi: implReadAbi,
            functionName: "VRF_KEY_HASH_2_GWEI",
        }),
        publicClient.readContract({
            address: previousImplementation,
            abi: implReadAbi,
            functionName: "VRF_KEY_HASH_30_GWEI",
        }),
        publicClient.readContract({
            address: previousImplementation,
            abi: implReadAbi,
            functionName: "VRF_KEY_HASH_150_GWEI",
        }),
        publicClient.readContract({
            address: previousImplementation,
            abi: implReadAbi,
            functionName: "VRF_CONFIRMATIONS",
        }),
        publicClient.readContract({
            address: previousImplementation,
            abi: implReadAbi,
            functionName: "BRB_REFERRAL",
        }),
    ]);

    console.log("Deploying linked libraries…");
    if (hre.network.name !== "hardhat") {
        await new Promise((r) => setTimeout(r, 3000));
    }
    const { addresses: linkedLibraries, engineLinks } = await deployRouletteEngineLibraries(deployer.account);
    if (hre.network.name !== "hardhat") {
        // Let the nonce settle after the multi-tx library batch (avoids "nonce too low" on next deploy).
        await new Promise((r) => setTimeout(r, 5000));
    }

    console.log("Deploying new RouletteEngine implementation…");
    const newEngineImpl = await viem.deployContract(
        "RouletteEngine",
        [vrfCoordinator, key2, key30, key150, confirmations, brbReferral],
        { account: deployer.account, libraries: engineLinks, gas: 8_000_000n },
    );
    console.log("New engine implementation:", newEngineImpl.address);

    const implCode = (await publicClient.getBytecode({ address: newEngineImpl.address }))?.toLowerCase() ?? "";
    if (!implCode.includes(VRF_V25_SELECTOR.slice(2).toLowerCase())) {
        throw new Error("New engine implementation missing VRF v2.5 selector — yarn compile and retry");
    }
    // Sanity: new selector for setUpkeepScheduler(address)
    const setSchedSel = toFunctionSelector("setUpkeepScheduler(address)").slice(2).toLowerCase();
    if (!implCode.includes(setSchedSel)) {
        throw new Error("New engine implementation missing setUpkeepScheduler — compile failed to include it?");
    }

    console.log("Upgrading engine proxy…");
    const upgradeHash = await deployer.writeContract({
        address: engineProxy,
        abi: implReadAbi,
        functionName: "upgradeToAndCall",
        args: [newEngineImpl.address, "0x"],
        account: deployer.account,
        chain: publicClient.chain,
        gas: 500_000n,
    });
    const upgradeReceipt = await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
    if (upgradeReceipt.status !== "success") throw new Error(`engine upgrade reverted (${upgradeHash})`);
    console.log("Engine upgraded:", upgradeHash);

    // ─── 2. Deploy new UpkeepScheduler ──────────────────────────────────────
    console.log("Deploying new UpkeepScheduler…");
    const newScheduler = await viem.deployContract(
        "UpkeepScheduler",
        [engineProxy, sideBet, deployer.account.address, scanLimit, maxPayoutsPerCall],
        { account: deployer.account },
    );
    console.log("New scheduler:", newScheduler.address);

    const [schedEngine, schedSideBet] = await Promise.all([
        publicClient.readContract({ address: newScheduler.address, abi: schedulerAbi, functionName: "ENGINE" }),
        publicClient.readContract({ address: newScheduler.address, abi: schedulerAbi, functionName: "SIDE_BET" }),
    ]);
    if (schedEngine.toLowerCase() !== engineProxy.toLowerCase()) {
        throw new Error(`New scheduler ENGINE mismatch: ${schedEngine}`);
    }
    if (schedSideBet.toLowerCase() !== sideBet.toLowerCase()) {
        throw new Error(`New scheduler SIDE_BET mismatch: ${schedSideBet}`);
    }

    // ─── 3. Wire permissions ────────────────────────────────────────────────
    console.log("setForwarderAuthority → CreExecutionAuthority…");
    const fwdHash = await deployer.writeContract({
        address: newScheduler.address,
        abi: schedulerAbi,
        functionName: "setForwarderAuthority",
        args: [creExecutionAuthority],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: fwdHash });

    console.log("engine.setUpkeepScheduler…");
    const setSchedHash = await deployer.writeContract({
        address: engineProxy,
        abi: engineAbi,
        functionName: "setUpkeepScheduler",
        args: [newScheduler.address],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: setSchedHash });

    const onChainSched = await publicClient.readContract({
        address: engineProxy,
        abi: engineAbi,
        functionName: "UPKEEP_SCHEDULER",
    });
    if (onChainSched.toLowerCase() !== newScheduler.address.toLowerCase()) {
        throw new Error(`setUpkeepScheduler did not persist: ${onChainSched}`);
    }

    console.log("SideBet grant SETTLEMENT_ROLE to new scheduler…");
    const grantHash = await deployer.writeContract({
        address: sideBet,
        abi: sideBetAbi,
        functionName: "grantRole",
        args: [SETTLEMENT_ROLE, newScheduler.address],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: grantHash });

    const oldHasSettlement = await publicClient.readContract({
        address: sideBet,
        abi: sideBetAbi,
        functionName: "hasRole",
        args: [SETTLEMENT_ROLE, oldScheduler],
    });
    if (oldHasSettlement) {
        console.log("SideBet revoke SETTLEMENT_ROLE from old scheduler…");
        const revokeHash = await deployer.writeContract({
            address: sideBet,
            abi: sideBetAbi,
            functionName: "revokeRole",
            args: [SETTLEMENT_ROLE, oldScheduler],
            account: deployer.account,
            chain: publicClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash: revokeHash });
    }

    console.log("AutomationReceiver allow performUpkeep on new scheduler…");
    const allowHash = await deployer.writeContract({
        address: automationReceiver,
        abi: receiverAbi,
        functionName: "setCallAllowed",
        args: [newScheduler.address, PERFORM_UPKEEP_SELECTOR, true],
        account: deployer.account,
        chain: publicClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: allowHash });

    const oldAllowed = await publicClient.readContract({
        address: automationReceiver,
        abi: receiverAbi,
        functionName: "isCallAllowed",
        args: [oldScheduler, PERFORM_UPKEEP_SELECTOR],
    });
    if (oldAllowed) {
        console.log("AutomationReceiver revoke old scheduler…");
        const denyHash = await deployer.writeContract({
            address: automationReceiver,
            abi: receiverAbi,
            functionName: "setCallAllowed",
            args: [oldScheduler, PERFORM_UPKEEP_SELECTOR, false],
            account: deployer.account,
            chain: publicClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash: denyHash });
    }

    // ─── 4. Verify checkUpkeep no longer reverts on lane 1 ──────────────────
    console.log("Verifying checkUpkeep(lane0) and checkUpkeep(lane1)…");
    const lane0 = await publicClient.readContract({
        address: newScheduler.address,
        abi: schedulerAbi,
        functionName: "checkUpkeep",
        args: ["0x"],
    });
    const lane1 = await publicClient.readContract({
        address: newScheduler.address,
        abi: schedulerAbi,
        functionName: "checkUpkeep",
        args: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
    });
    console.log(
        JSON.stringify(
            {
                lane0Needed: lane0[0],
                lane0PerformDataBytes: (lane0[1].length - 2) / 2,
                lane1Needed: lane1[0],
                lane1PerformDataBytes: (lane1[1].length - 2) / 2,
            },
            null,
            2,
        ),
    );

    // ─── 5. Persist addresses + CRE configs ─────────────────────────────────
    deploy.addresses.scheduler = getAddress(newScheduler.address);
    (deploy as { previousScheduler?: string }).previousScheduler = getAddress(oldScheduler);
    (deploy as { schedulerRedeployedAt?: string }).schedulerRedeployedAt = new Date().toISOString();
    writeFileSync(DEPLOY_JSON, `${JSON.stringify(deploy, null, 2)}\n`, "utf8");
    console.log("Updated", DEPLOY_JSON);

    writeCreWorkflowConfigs({
        network: "arbitrum-sepolia",
        scheduler: newScheduler.address as Address,
        receiver: automationReceiver as Address,
        engine: engineProxy as Address,
        laneCount: Number(payoutLanes),
        writeGasLimit: "2500000",
    });
    writeCreHttpConfigs({
        network: "arbitrum-sepolia",
        scheduler: newScheduler.address as Address,
        receiver: automationReceiver as Address,
        writeGasLimit: "2500000",
        httpAuthorizedKeys: [httpAuthorized as Address],
    });
    console.log("Regenerated CRE workflow configs for new scheduler");

    const wantVerify = envBool("VERIFY_CONTRACTS", true);
    if (wantVerify) {
        const delayMs = Number(process.env.VERIFY_DELAY_MS ?? "8000");
        console.log("Verifying on Arbiscan…");
        await verifyRouletteLinkedLibraries(linkedLibraries, delayMs);
        await verifyContractWithDelay(
            newEngineImpl.address,
            [vrfCoordinator, key2, key30, key150, confirmations, brbReferral],
            delayMs,
            FQ_ROULETTE_ENGINE,
            buildRouletteEngineLibraryMap(linkedLibraries),
        );
        await verifyContractWithDelay(
            newScheduler.address,
            [engineProxy, sideBet, deployer.account.address, scanLimit, maxPayoutsPerCall],
            delayMs,
            FQ_UPKEEP_SCHEDULER,
        );
    }

    console.log(
        JSON.stringify(
            {
                ok: true,
                oldScheduler,
                newScheduler: newScheduler.address,
                engineImplementation: newEngineImpl.address,
                upgradeTx: upgradeHash,
                setSchedulerTx: setSchedHash,
                next: [
                    "Update cre-automation-starter/.env SCHEDULER_ADDRESS",
                    "cre workflow deploy … for trigger-vrf + lane0 + lane1",
                ],
            },
            null,
            2,
        ),
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
