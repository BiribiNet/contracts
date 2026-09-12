import { readFileSync } from "node:fs";
import { join } from "node:path";

import "dotenv/config";

import { viem } from "hardhat";
import { getAddress, isAddress, parseAbi } from "viem";

import { verifyContractWithDelay } from "./utils/verifyWithEtherscan";

/**
 * Beacon-upgrade every live Arbitrum Sepolia `BankVault4626` to the current local implementation.
 *
 * Vaults are BeaconProxies sharing `MarketRegistry.vaultBeacon`. `upgradeTo` on that beacon
 * atomically points USDC / DAI / BRB banks at the new code (liquidity-split with roulette,
 * `drainWithdrawalQueue` hatch, no-position withdraw reject). Storage is ERC-7201 namespaced
 * and this revision does not add fields, so existing vault state is preserved.
 *
 * Do **not** call `MarketRegistry.setVaultBeacon` here — that would replace the beacon
 * address and orphan every already-deployed proxy.
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` (must be `UpgradeableBeacon.owner()`)
 * - `hardhat vars set ARBITRUM_SEPOLIA_RPC_URL`
 * - `yarn compile` on the revision you want on-chain
 *
 * Env:
 * - REGISTRY_ADDRESS — default: ../subgraph/deployments/arbitrum-sepolia.json `addresses.registry`
 * - VERIFY_CONTRACTS — default true when `ETHERSCAN_API_KEY` is set
 * - VERIFY_DELAY_MS — default 8000
 *
 * Run: `yarn upgrade:vault:arbitrum-sepolia`
 */

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const FQ_BANK_VAULT = "contracts/BankVault4626.sol:BankVault4626" as const;
const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

const registryAbi = parseAbi([
    "function vaultBeacon() view returns (address)",
    "function marketCount() view returns (uint32)",
    "function getMarket(uint32 marketId) view returns ((address asset, address bank))",
]);

const beaconAbi = parseAbi([
    "function owner() view returns (address)",
    "function implementation() view returns (address)",
    "function upgradeTo(address newImplementation)",
]);

const vaultAbi = parseAbi([
    "function marketId() view returns (uint32)",
    "function availableForSideBet() view returns (uint256)",
    "function lockedBetLiquidity() view returns (uint256)",
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

function readDeployedRegistry(): `0x${string}` {
    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8")) as {
        addresses: { registry: `0x${string}` };
    };
    return deploy.addresses.registry;
}

async function main(): Promise<void> {
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got chainId ${chainId}`);
    }

    const registry = envAddress("REGISTRY_ADDRESS", readDeployedRegistry());
    const beacon = getAddress(
        await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "vaultBeacon" }),
    );
    if (beacon === "0x0000000000000000000000000000000000000000") {
        throw new Error(`Registry ${registry} has no vaultBeacon set`);
    }

    const [beaconOwner, previousImplementation, marketCount] = await Promise.all([
        publicClient.readContract({ address: beacon, abi: beaconAbi, functionName: "owner" }),
        publicClient.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation" }),
        publicClient.readContract({ address: registry, abi: registryAbi, functionName: "marketCount" }),
    ]);

    if (getAddress(beaconOwner) !== getAddress(deployer.account.address)) {
        throw new Error(
            `Deployer ${deployer.account.address} is not UpgradeableBeacon.owner (${beaconOwner}) — upgrade aborted.`,
        );
    }

    const banks: { marketId: number; bank: `0x${string}`; marketIdOnVault: string; locked: string }[] = [];
    for (let marketId = 1; marketId <= Number(marketCount); marketId += 1) {
        const market = await publicClient.readContract({
            address: registry,
            abi: registryAbi,
            functionName: "getMarket",
            args: [marketId],
        });
        const [vaultMarketId, locked] = await Promise.all([
            publicClient.readContract({ address: market.bank, abi: vaultAbi, functionName: "marketId" }),
            publicClient.readContract({ address: market.bank, abi: vaultAbi, functionName: "lockedBetLiquidity" }),
        ]);
        banks.push({
            marketId,
            bank: getAddress(market.bank),
            marketIdOnVault: vaultMarketId.toString(),
            locked: locked.toString(),
        });
    }

    console.log("Registry:", registry);
    console.log("Vault beacon:", beacon);
    console.log("Current implementation:", previousImplementation);
    console.log("Markets:", JSON.stringify(banks, null, 2));

    console.log("Deploying new BankVault4626 implementation…");
    const newImplementation = await viem.deployContract("BankVault4626", [], { account: deployer.account });
    console.log("New implementation:", newImplementation.address);

    const newCode = await publicClient.getBytecode({ address: newImplementation.address });
    if (!newCode || newCode === "0x") {
        throw new Error(`New implementation ${newImplementation.address} has no bytecode`);
    }

    console.log("Calling UpgradeableBeacon.upgradeTo…");
    const upgradeHash = await deployer.writeContract({
        address: beacon,
        abi: beaconAbi,
        functionName: "upgradeTo",
        args: [newImplementation.address],
        account: deployer.account,
        chain: publicClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
    if (receipt.status !== "success") {
        throw new Error(`beacon.upgradeTo reverted (tx ${upgradeHash})`);
    }

    const upgradedImplementation = getAddress(
        await publicClient.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation" }),
    );
    if (upgradedImplementation !== getAddress(newImplementation.address)) {
        throw new Error(
            `Beacon implementation mismatch after upgrade: ${upgradedImplementation} != ${newImplementation.address}`,
        );
    }

    for (const row of banks) {
        const [vaultMarketId, available] = await Promise.all([
            publicClient.readContract({ address: row.bank, abi: vaultAbi, functionName: "marketId" }),
            publicClient.readContract({ address: row.bank, abi: vaultAbi, functionName: "availableForSideBet" }),
        ]);
        if (vaultMarketId.toString() !== row.marketIdOnVault) {
            throw new Error(`Vault ${row.bank} marketId changed after upgrade: ${vaultMarketId} vs ${row.marketIdOnVault}`);
        }
        console.log(
            `  market ${row.marketId} ${row.bank} still marketId=${vaultMarketId} availableForSideBet=${available}`,
        );
        try {
            await publicClient.simulateContract({
                address: row.bank,
                abi: parseAbi(["function drainWithdrawalQueue(uint256 maxCount) returns (uint256)"]),
                functionName: "drainWithdrawalQueue",
                args: [0n],
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/ZeroAmount|WithdrawalBlockedDuringResolution/.test(msg)) {
                throw new Error(`drainWithdrawalQueue missing or unexpected revert on ${row.bank}: ${msg.split("\n")[0]}`);
            }
        }
    }

    console.log("Upgrade succeeded.");
    console.log(
        JSON.stringify(
            {
                registry,
                beacon,
                previousImplementation,
                newImplementation: newImplementation.address,
                upgradeTx: upgradeHash,
                banks: banks.map((b) => b.bank),
            },
            null,
            2,
        ),
    );

    if (envBool("VERIFY_CONTRACTS", true)) {
        const delayMs = Number(process.env.VERIFY_DELAY_MS ?? "8000");
        console.log("Verifying the new BankVault4626 implementation on Arbiscan…");
        await verifyContractWithDelay(newImplementation.address, [], delayMs, FQ_BANK_VAULT);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
