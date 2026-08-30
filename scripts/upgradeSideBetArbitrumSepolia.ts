import { readFileSync } from "node:fs";
import { join } from "node:path";

import { viem } from "hardhat";

import { getAddress, isAddress, parseAbi, zeroHash } from "viem";

/**
 * UUPS-upgrade the live Arbitrum Sepolia `SideBet` proxy to the current local implementation.
 *
 * WHY: the deployed implementation predates the side-bet security fixes (multi-market winner
 * payouts, lane realignment, post-VRF placement guard, undecided-bet expiry). Its bytecode is
 * missing `settleTimeout()`, `setSettleTimeout(uint64)` and the current `settleBatch` signature,
 * so settlement through `UpkeepScheduler` cannot work against the current ABI.
 *
 * THE POST-UPGRADE CALL IS NOT OPTIONAL: `DEFAULT_SETTLE_TIMEOUT` is applied only inside
 * `initialize`, so an upgraded proxy reads `settleTimeout == 0` and expiry stays disabled. A bet
 * that never becomes decidable — its market went quiet, so global rounds stopped advancing — would
 * then pin its lane cursor forever. This script therefore always sets the timeout after upgrading.
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` (must hold `DEFAULT_ADMIN_ROLE` on the SideBet proxy)
 * - `hardhat vars set ARBITRUM_SEPOLIA_RPC_URL`
 * - `yarn compile` on the revision you want on-chain
 *
 * Env:
 * - SIDE_BET_PROXY   — default: ../subgraph/deployments/arbitrum-sepolia.json `addresses.sideBet`
 * - SETTLE_TIMEOUT_SECONDS — default 2592000 (30 days, matching `DEFAULT_SETTLE_TIMEOUT`)
 * - VERIFY_CONTRACTS — default true when `ETHERSCAN_API_KEY` is set
 * - VERIFY_DELAY_MS  — default 8000
 *
 * Run: `yarn upgrade:side-bet:arbitrum-sepolia`
 */
import "dotenv/config";

import { verifyContractWithDelay } from "./utils/verifyWithEtherscan";

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const ERC1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const FQ_SIDE_BET = "contracts/SideBet.sol:SideBet" as const;

/** `SideBet.DEFAULT_SETTLE_TIMEOUT`. */
const DEFAULT_SETTLE_TIMEOUT_SECONDS = 30n * 24n * 60n * 60n;

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

const proxyAbi = parseAbi([
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
    "function settleTimeout() view returns (uint64)",
    "function setSettleTimeout(uint64 newSettleTimeout)",
    "function configCount() view returns (uint256)",
    "function betCount() view returns (uint256)",
]);

function envAddress(name: string, fallback: `0x${string}`): `0x${string}` {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    if (!isAddress(raw)) throw new Error(`${name} must be a valid address: ${raw}`);
    return raw;
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
): Promise<`0x${string}`> {
    const raw = await publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT });
    if (!raw) throw new Error(`Could not read the implementation slot of ${proxy}`);
    return getAddress(`0x${raw.slice(-40)}`);
}

function readDeployedSideBet(): `0x${string}` {
    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8")) as {
        addresses: { sideBet: `0x${string}` };
    };
    return deploy.addresses.sideBet;
}

async function main(): Promise<void> {
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got chainId ${chainId}`);
    }

    const sideBetProxy = envAddress("SIDE_BET_PROXY", readDeployedSideBet());
    const settleTimeout = BigInt(process.env.SETTLE_TIMEOUT_SECONDS?.trim() || DEFAULT_SETTLE_TIMEOUT_SECONDS);

    const previousImplementation = await readErc1967Implementation(publicClient, sideBetProxy);
    console.log("SideBet proxy:", sideBetProxy);
    console.log("Current implementation:", previousImplementation);

    const isAdmin = await publicClient.readContract({
        address: sideBetProxy,
        abi: proxyAbi,
        functionName: "hasRole",
        args: [zeroHash, deployer.account.address],
    });
    if (!isAdmin) {
        throw new Error(
            `Deployer ${deployer.account.address} lacks DEFAULT_ADMIN_ROLE on the SideBet proxy — upgrade aborted.`,
        );
    }

    console.log("Deploying new SideBet implementation…");
    const newImplementation = await viem.deployContract("SideBet", [], { account: deployer.account });
    console.log("New implementation:", newImplementation.address);

    console.log("Calling upgradeToAndCall on proxy…");
    const upgradeHash = await deployer.writeContract({
        address: sideBetProxy,
        abi: proxyAbi,
        functionName: "upgradeToAndCall",
        args: [newImplementation.address, "0x"],
        account: deployer.account,
        chain: publicClient.chain,
    });
    const upgradeReceipt = await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
    if (upgradeReceipt.status !== "success") {
        throw new Error(`upgradeToAndCall reverted (tx ${upgradeHash})`);
    }

    const upgradedImplementation = await readErc1967Implementation(publicClient, sideBetProxy);
    if (upgradedImplementation.toLowerCase() !== newImplementation.address.toLowerCase()) {
        throw new Error(
            `Implementation slot mismatch after upgrade: ${upgradedImplementation} != ${newImplementation.address}`,
        );
    }

    // The upgraded proxy inherits storage that never held `settleTimeout`, so it reads 0 (expiry
    // disabled). Always write it, and prove it stuck.
    const timeoutBefore = await publicClient.readContract({
        address: sideBetProxy,
        abi: proxyAbi,
        functionName: "settleTimeout",
    });
    console.log(`settleTimeout after upgrade: ${timeoutBefore} — setting to ${settleTimeout}s`);

    const timeoutHash = await deployer.writeContract({
        address: sideBetProxy,
        abi: proxyAbi,
        functionName: "setSettleTimeout",
        args: [settleTimeout],
        account: deployer.account,
        chain: publicClient.chain,
    });
    const timeoutReceipt = await publicClient.waitForTransactionReceipt({ hash: timeoutHash });
    if (timeoutReceipt.status !== "success") {
        throw new Error(`setSettleTimeout reverted (tx ${timeoutHash})`);
    }

    const timeoutAfter = await publicClient.readContract({
        address: sideBetProxy,
        abi: proxyAbi,
        functionName: "settleTimeout",
    });
    if (timeoutAfter !== settleTimeout) {
        throw new Error(`settleTimeout is ${timeoutAfter} after the write, expected ${settleTimeout}`);
    }

    const [configCount, betCount] = await Promise.all([
        publicClient.readContract({ address: sideBetProxy, abi: proxyAbi, functionName: "configCount" }),
        publicClient.readContract({ address: sideBetProxy, abi: proxyAbi, functionName: "betCount" }),
    ]);

    console.log("Upgrade succeeded.");
    console.log(
        JSON.stringify(
            {
                sideBetProxy,
                previousImplementation,
                newImplementation: newImplementation.address,
                upgradeTx: upgradeHash,
                settleTimeoutTx: timeoutHash,
                settleTimeout: settleTimeout.toString(),
                configCount: configCount.toString(),
                betCount: betCount.toString(),
            },
            null,
            2,
        ),
    );

    if (configCount === 0n) {
        console.warn(
            "\nconfigCount is 0 — no bet template exists, so the UI will still show an empty catalogue. " +
                "Run `yarn seed:side-bets:arbitrum-sepolia` next.",
        );
    }

    if (envBool("VERIFY_CONTRACTS", true)) {
        const delayMs = Number(process.env.VERIFY_DELAY_MS ?? "8000");
        console.log("Verifying the new implementation on Arbiscan…");
        await verifyContractWithDelay(newImplementation.address, [], delayMs, FQ_SIDE_BET);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
