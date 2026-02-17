import { viem } from "hardhat";
import { parseEther } from "viem";
import { readFileSync } from "fs";
import { join } from "path";

interface RecipientsConfig {
    recipients: string[];
}

const main = async () => {
    const brb = await viem.getContractAt("BRB", "0x59f1b9ec56f3e73687820af17c0d71b134fc43e2");
    const stakedBrbProxy = await viem.getContractAt("StakedBRB", "0x6Eae6dD7c11d2B9C748a2D6Af2e3B2f0589ec279");
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Load recipient addresses from JSON file
    // Use process.cwd() to get the project root, then navigate to scripts folder
    const configPath = join(process.cwd(), "scripts", "recipients.json");
    let recipientAddresses: `0x${string}`[] = [];

    try {
        const configFile = readFileSync(configPath, "utf-8");
        const config: RecipientsConfig = JSON.parse(configFile);
        
        if (!config.recipients || !Array.isArray(config.recipients)) {
            throw new Error("Invalid JSON format: 'recipients' must be an array");
        }
        
        recipientAddresses = config.recipients.map(addr => {
            if (!addr.startsWith("0x") || addr.length !== 42) {
                throw new Error(`Invalid address format: ${addr}`);
            }
            return addr.toLowerCase() as `0x${string}`;
        });
    } catch (error: any) {
        if (error.code === "ENOENT") {
            console.error(`\n❌ Error: recipients.json not found at ${configPath}`);
            console.error("Please create recipients.json file with the following format:");
            console.error(JSON.stringify({ recipients: ["0x...", "0x..."] }, null, 2));
            console.error("\nYou can copy recipients.example.json as a template:");
            console.error("cp scripts/recipients.example.json scripts/recipients.json");
        } else {
            console.error(`\n❌ Error reading recipients.json: ${error.message}`);
        }
        process.exitCode = 1;
        return;
    }

    if (recipientAddresses.length === 0) {
        console.error("❌ Error: No recipient addresses found in recipients.json");
        process.exitCode = 1;
        return;
    }

    const amountPerRecipient = parseEther("100000"); // 100000 BRB per recipient
    const stakeAmount = parseEther("1000000"); // 1000000 BRB to stake
    const totalDistributionAmount = amountPerRecipient * BigInt(recipientAddresses.length);
    const totalNeeded = totalDistributionAmount + stakeAmount;

    console.log(`Total BRB needed: ${totalNeeded.toString()}`);
    console.log(`Distribution: ${totalDistributionAmount.toString()} (${recipientAddresses.length} recipients × ${amountPerRecipient.toString()})`);
    console.log(`Staking: ${stakeAmount.toString()}`);

    // Check deployer balance
    const deployerBalance = await brb.read.balanceOf([deployer.account.address]);
    console.log(`Deployer BRB balance: ${deployerBalance.toString()}`);

    if (deployerBalance < totalNeeded) {
        console.error(`Insufficient balance. Need ${totalNeeded.toString()}, have ${deployerBalance.toString()}`);
        process.exitCode = 1;
        return;
    }

    // Step 1: Distribute BRB to all recipients
    console.log("\n=== Distributing BRB to recipients ===");
    for (let i = 0; i < recipientAddresses.length; i++) {
        const recipient = recipientAddresses[i];
        console.log(`Sending ${amountPerRecipient.toString()} BRB to ${recipient} (${i + 1}/${recipientAddresses.length})`);
        
        const txHash = await brb.write.transfer([recipient, amountPerRecipient], { account: deployer.account });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        
        const recipientBalance = await brb.read.balanceOf([recipient]);
        console.log(`  ✓ Sent. Recipient balance: ${recipientBalance.toString()}`);
    }

    // Step 2: Approve staking contract
    console.log("\n=== Approving StakedBRB contract ===");
    const approveTxHash = await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    console.log(`✓ Approved ${stakeAmount.toString()} BRB for staking`);

    // Step 3: Stake in the staking pool
    console.log("\n=== Staking BRB ===");
    console.log(`Staking ${stakeAmount.toString()} BRB...`);
    
    const stakeTxHash = await stakedBrbProxy.write.deposit([stakeAmount, deployer.account.address, 0n], { account: deployer.account });
    const stakeReceipt = await publicClient.waitForTransactionReceipt({ hash: stakeTxHash });
    console.log(`✓ Staked successfully. Tx: ${stakeTxHash}`);

    // Verify staking
    const stakerShares = await stakedBrbProxy.read.balanceOf([deployer.account.address]);
    const totalAssets = await stakedBrbProxy.read.totalAssets();
    console.log(`  Staker shares: ${stakerShares.toString()}`);
    console.log(`  Total assets in pool: ${totalAssets.toString()}`);

    // Final balance check
    const finalBalance = await brb.read.balanceOf([deployer.account.address]);
    console.log(`\n=== Summary ===`);
    console.log(`Final deployer BRB balance: ${finalBalance.toString()}`);
    console.log(`Total distributed: ${totalDistributionAmount.toString()}`);
    console.log(`Total staked: ${stakeAmount.toString()}`);
    console.log(`Recipients: ${recipientAddresses.length}`);
    console.log("\n✓ Distribution and staking complete!");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});