import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import hre from "hardhat";
import { viem } from "hardhat";
import { getAddress, isAddress, parseUnits } from "viem";

interface RecipientsConfig {
    recipients: string[];
}

interface SubgraphDeployment {
    addresses: {
        brb: string;
    };
}

const DEFAULT_DEPLOY_BY_NETWORK: Record<string, string> = {
    arbitrumsepolia: "deployments/arbitrum-sepolia.json",
    arbitrum: "deployments/arbitrum-one.json",
};

function subgraphRoot(): string {
    return join(__dirname, "..", "..", "subgraph");
}

function resolveDeployJsonPath(networkName: string | undefined): string {
    const subgraphDir = subgraphRoot();
    const fromEnv = process.env.DEPLOY_JSON?.trim();
    if (fromEnv) {
        return fromEnv.startsWith("/") ? fromEnv : join(subgraphDir, fromEnv.replace(/^\.\//, ""));
    }
    const relative =
        (networkName && DEFAULT_DEPLOY_BY_NETWORK[networkName]) ??
        "deployments/arbitrum-sepolia.json";
    return join(subgraphDir, relative);
}

function resolveBrbTokenAddress(networkName: string | undefined): `0x${string}` {
    const explicit = process.env.BRB_TOKEN?.trim();
    if (explicit) {
        if (!isAddress(explicit)) {
            throw new Error(`BRB_TOKEN is not a valid address: ${explicit}`);
        }
        return getAddress(explicit);
    }

    const deployPath = resolveDeployJsonPath(networkName);
    let raw: string;
    try {
        raw = readFileSync(deployPath, "utf-8");
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            throw new Error(
                `Deployment manifest not found at ${deployPath}. Run the protocol deploy or set BRB_TOKEN / DEPLOY_JSON.`,
            );
        }
        throw error;
    }

    const manifest = JSON.parse(raw) as SubgraphDeployment;
    const brb = manifest.addresses?.brb;
    if (!brb || !isAddress(brb)) {
        throw new Error(`No valid addresses.brb in ${deployPath}`);
    }
    return getAddress(brb);
}

function loadRecipients(configPath: string): `0x${string}`[] {
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf-8");
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            throw new Error(
                `recipients.json not found at ${configPath}. Copy scripts/recipients.example.json to scripts/recipients.json and fill in addresses.`,
            );
        }
        throw error;
    }

    const config = JSON.parse(raw) as RecipientsConfig;
    if (!Array.isArray(config.recipients) || config.recipients.length === 0) {
        throw new Error('recipients.json must contain a non-empty "recipients" array');
    }

    return config.recipients.map((addr, i) => {
        if (!isAddress(addr)) {
            throw new Error(`Invalid address at recipients[${i}]: ${addr}`);
        }
        return getAddress(addr);
    });
}

async function main() {
    const networkName = hre.network.name;
    const deployPath = resolveDeployJsonPath(networkName);
    const tokenAddress = resolveBrbTokenAddress(networkName);

    const amountHuman = process.env.BRB_AMOUNT_PER_RECIPIENT ?? "100000";
    const decimals = Number(process.env.BRB_DECIMALS ?? "18");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error("BRB_DECIMALS must be an integer between 0 and 36");
    }
    const amountPerRecipient = parseUnits(amountHuman, decimals);

    const configPath = join(process.cwd(), "scripts", "recipients.json");
    const recipients = loadRecipients(configPath);
    const dryRun = process.env.DRY_RUN === "true";

    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet.account) {
        throw new Error("Signer wallet has no account");
    }

    const brb = await viem.getContractAt("BRBToken", tokenAddress);
    const totalDistribution = amountPerRecipient * BigInt(recipients.length);

    console.log(`Network: ${networkName} (chain ${await publicClient.getChainId()})`);
    if (!process.env.BRB_TOKEN?.trim()) {
        console.log(`Deployment manifest: ${deployPath}`);
    } else {
        console.log("BRB_TOKEN override (manifest ignored)");
    }
    console.log(`Token: ${brb.address}`);
    console.log(`Sender: ${wallet.account.address}`);
    console.log(`Recipients: ${recipients.length}`);
    console.log(`Amount per recipient: ${amountHuman} (${amountPerRecipient.toString()} base units)`);
    console.log(`Total to distribute: ${totalDistribution.toString()} base units`);
    if (dryRun) {
        console.log("DRY_RUN=true — no transfers will be sent");
    }

    const senderBalance = await brb.read.balanceOf([wallet.account.address]);
    console.log(`Sender balance: ${senderBalance.toString()} base units`);
    if (senderBalance < totalDistribution) {
        throw new Error(
            `Insufficient BRB balance: need ${totalDistribution.toString()}, have ${senderBalance.toString()}`,
        );
    }

    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];
        console.log(`\n[${i + 1}/${recipients.length}] ${amountHuman} BRB → ${recipient}`);

        if (dryRun) {
            continue;
        }

        const txHash = await brb.write.transfer([recipient, amountPerRecipient], {
            account: wallet.account,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") {
            throw new Error(`Transfer to ${recipient} reverted (tx ${txHash})`);
        }

        const recipientBalance = await brb.read.balanceOf([recipient]);
        console.log(`  ✓ tx ${txHash}`);
        console.log(`  recipient balance: ${recipientBalance.toString()} base units`);
    }

    if (!dryRun) {
        const finalBalance = await brb.read.balanceOf([wallet.account.address]);
        console.log(`\nDone. Sender remaining balance: ${finalBalance.toString()} base units`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
