import "dotenv/config";

import { viem } from "hardhat";
import { getAddress, isAddress, keccak256, parseAbi, toBytes, zeroHash } from "viem";

import { deployRouletteEngineLibraries } from "./utils/deployRouletteEngineLibraries";
import {
    buildRouletteEngineLibraryMap,
    verifyContractWithDelay,
    verifyRouletteLinkedLibraries,
} from "./utils/verifyWithEtherscan";

/**
 * UUPS-upgrade the live Arbitrum Sepolia `RouletteEngine` proxy to the current local implementation.
 *
 * Prerequisites:
 * - `hardhat vars set BRB_KEY` (must hold `DEFAULT_ADMIN_ROLE` on the engine proxy)
 * - `hardhat vars set ARBITRUM_SEPOLIA_RPC_URL`
 * - `yarn compile` on the revision you want on-chain
 *
 * Env:
 * - ENGINE_PROXY — default `0x4cf6a900fcdd3a33b2bb1df22b8718dd24e897f8`
 * - VRF_COORDINATOR — default Arbitrum Sepolia coordinator (must match original deploy)
 * - VERIFY_CONTRACTS — default true when `ETHERSCAN_API_KEY` is set
 * - VERIFY_DELAY_MS — default 8000
 *
 * Run: `yarn upgrade:engine:arbitrum-sepolia`
 */

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const ERC1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const DEFAULT_ENGINE_PROXY = "0x4cf6a900fcdd3a33b2bb1df22b8718dd24e897f8" as const;
const DEFAULT_VRF_COORDINATOR = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as const;

const FQ_ROULETTE_ENGINE = "contracts/RouletteEngine.sol:RouletteEngine" as const;

/** VRF v2.5 `requestRandomWords(RandomWordsRequest)` selector in current local build. */
const VRF_V25_SELECTOR = keccak256(toBytes("requestRandomWords((bytes32,uint256,uint16,uint32,uint32,bytes))")).slice(
    0,
    10,
);

const implReadAbi = parseAbi([
    "function VRF_KEY_HASH_2_GWEI() view returns (bytes32)",
    "function VRF_KEY_HASH_30_GWEI() view returns (bytes32)",
    "function VRF_KEY_HASH_150_GWEI() view returns (bytes32)",
    "function VRF_CONFIRMATIONS() view returns (uint16)",
    "function BRB_REFERRAL() view returns (address)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function upgradeToAndCall(address newImplementation, bytes data) payable",
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

async function readErc1967Implementation(publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>, proxy: `0x${string}`) {
    const raw = await publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT });
    return getAddress(`0x${raw.slice(-40)}`);
}

async function implementationUsesVrfV25(
    publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>,
    implementation: `0x${string}`,
): Promise<boolean> {
    const code = (await publicClient.getBytecode({ address: implementation }))?.toLowerCase() ?? "";
    return code.includes(VRF_V25_SELECTOR.slice(2).toLowerCase());
}

async function main() {
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    if (!deployer.account) throw new Error("Deployer wallet has no account");

    const chainId = await publicClient.getChainId();
    if (BigInt(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got chainId ${chainId}`);
    }

    const engineProxy = envAddress("ENGINE_PROXY", DEFAULT_ENGINE_PROXY);
    const vrfCoordinator = envAddress("VRF_COORDINATOR", DEFAULT_VRF_COORDINATOR);

    const previousImplementation = await readErc1967Implementation(publicClient, engineProxy);
    console.log("Engine proxy:", engineProxy);
    console.log("Current implementation:", previousImplementation);

    const alreadyVrfV25 = await implementationUsesVrfV25(publicClient, previousImplementation);
    if (alreadyVrfV25) {
        console.log("Current implementation already uses VRF v2.5 RandomWordsRequest — no upgrade needed.");
        return;
    }

    const [key2, key30, key150, confirmations, brbReferral] = await Promise.all([
        publicClient.readContract({ address: previousImplementation, abi: implReadAbi, functionName: "VRF_KEY_HASH_2_GWEI" }),
        publicClient.readContract({ address: previousImplementation, abi: implReadAbi, functionName: "VRF_KEY_HASH_30_GWEI" }),
        publicClient.readContract({ address: previousImplementation, abi: implReadAbi, functionName: "VRF_KEY_HASH_150_GWEI" }),
        publicClient.readContract({ address: previousImplementation, abi: implReadAbi, functionName: "VRF_CONFIRMATIONS" }),
        publicClient.readContract({ address: previousImplementation, abi: implReadAbi, functionName: "BRB_REFERRAL" }),
    ]);

    const isAdmin = await publicClient.readContract({
        address: engineProxy,
        abi: implReadAbi,
        functionName: "hasRole",
        args: [zeroHash, deployer.account.address],
    });
    if (!isAdmin) {
        throw new Error(
            `Deployer ${deployer.account.address} lacks DEFAULT_ADMIN_ROLE on engine proxy — upgrade aborted.`,
        );
    }

    console.log("Deploying linked libraries…");
    const { addresses: linkedLibraries, engineLinks } = await deployRouletteEngineLibraries(deployer.account);

    console.log("Deploying new RouletteEngine implementation…");
    const newImplementation = await viem.deployContract(
        "RouletteEngine",
        [vrfCoordinator, key2, key30, key150, confirmations, brbReferral],
        { account: deployer.account, libraries: engineLinks },
    );
    console.log("New implementation:", newImplementation.address);

    const newUsesVrfV25 = await implementationUsesVrfV25(publicClient, newImplementation.address);
    if (!newUsesVrfV25) {
        throw new Error("New implementation bytecode missing VRF v2.5 selector — run `yarn compile` and retry.");
    }

    console.log("Calling upgradeToAndCall on proxy…");
    const upgradeHash = await deployer.writeContract({
        address: engineProxy,
        abi: implReadAbi,
        functionName: "upgradeToAndCall",
        args: [newImplementation.address, "0x"],
        account: deployer.account,
        chain: publicClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: upgradeHash });
    if (receipt.status !== "success") {
        throw new Error(`upgradeToAndCall reverted (tx ${upgradeHash})`);
    }

    const upgradedImplementation = await readErc1967Implementation(publicClient, engineProxy);
    if (upgradedImplementation.toLowerCase() !== newImplementation.address.toLowerCase()) {
        throw new Error(`Implementation slot mismatch after upgrade: ${upgradedImplementation} != ${newImplementation.address}`);
    }

    console.log("Upgrade succeeded.");
    console.log(
        JSON.stringify(
            {
                engineProxy,
                previousImplementation,
                newImplementation: newImplementation.address,
                vrfCoordinator,
                brbReferral,
                vrfKeyHashes: { key2, key30, key150 },
                vrfConfirmations: confirmations,
                upgradeTx: upgradeHash,
                linkedLibraries,
            },
            null,
            2,
        ),
    );

    const wantVerify = envBool("VERIFY_CONTRACTS", true);
    if (wantVerify) {
        const delayMs = Number(process.env.VERIFY_DELAY_MS ?? "8000");
        console.log("Verifying linked libraries and new implementation on Arbiscan…");
        await verifyRouletteLinkedLibraries(linkedLibraries, delayMs);
        await verifyContractWithDelay(
            newImplementation.address,
            [vrfCoordinator, key2, key30, key150, confirmations, brbReferral],
            delayMs,
            FQ_ROULETTE_ENGINE,
            buildRouletteEngineLibraryMap(linkedLibraries),
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
