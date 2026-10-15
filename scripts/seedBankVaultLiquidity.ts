/**
 * Post-deploy: seed BankVault4626 liquidity on Arbitrum Sepolia.
 * Run after deployProtocolArbitrumSepolia.ts (reads ../subgraph/deployments/arbitrum-sepolia.json).
 *
 *   yarn hardhat run scripts/seedBankVaultLiquidity.ts --network arbitrumsepolia
 */
import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { viem } from "hardhat";
import { parseUnits } from "viem";

const DEPLOY_JSON = join(__dirname, "..", "..", "subgraph", "deployments", "arbitrum-sepolia.json");

async function main() {
    const deploy = JSON.parse(readFileSync(DEPLOY_JSON, "utf8")) as {
        addresses: {
            brb: `0x${string}`;
            banks: [`0x${string}`, `0x${string}`, `0x${string}`];
            jackpotTreasury: `0x${string}`;
        };
    };

    const [deployer] = await viem.getWalletClients();
    if (!deployer.account) throw new Error("no deployer account");

    const usdc = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;
    const [bankUsdc, bankDai, bankBrb] = deploy.addresses.banks;
    const brb = deploy.addresses.brb;

    const bankUsdcC = await viem.getContractAt("BankVault4626", bankUsdc);
    const bankDaiC = await viem.getContractAt("BankVault4626", bankDai);
    const bankBrbC = await viem.getContractAt("BankVault4626", bankBrb);
    const daiAsset = await bankDaiC.read.asset();

    const usdcAmount = parseUnits(process.env.SEED_BANK_USDC?.trim() || "10000", 6);
    const daiAmount = parseUnits(process.env.SEED_BANK_DAI?.trim() || "10000", 18);
    const brbAmount = parseUnits(process.env.SEED_BANK_BRB?.trim() || "50000", 18);
    const treasuryBrb = parseUnits(process.env.SEED_JACKPOT_TREASURY_BRB?.trim() || "10000", 18);

    const usdcC = await viem.getContractAt("MockUSDC", usdc);
    const brbC = await viem.getContractAt("BRBToken", brb);
    const daiC = await viem.getContractAt("MockDAI", daiAsset);

    const pc = await viem.getPublicClient();
    const usdcBal = await pc.readContract({
        address: usdc,
        abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
        functionName: "balanceOf",
        args: [deployer.account.address],
    });

    const wait = async (hash: `0x${string}`) => {
        const r = await pc.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
    };

    if (usdcBal >= usdcAmount) {
        await usdcC.write.approve([bankUsdc, usdcAmount], { account: deployer.account });
        await wait(await bankUsdcC.write.deposit([usdcAmount, deployer.account.address], { account: deployer.account }));
        console.log(`Deposited ${usdcAmount} USDC wei → bank ${bankUsdc}`);
    } else {
        console.warn(`Skipping USDC bank seed: balance ${usdcBal} < ${usdcAmount} — fund deployer with Circle USDC on Sepolia.`);
    }

    await daiC.write.mint([deployer.account.address, daiAmount], { account: deployer.account });
    await daiC.write.approve([bankDai, daiAmount], { account: deployer.account });
    await wait(await bankDaiC.write.deposit([daiAmount, deployer.account.address], { account: deployer.account }));
    console.log(`Deposited ${daiAmount} DAI wei → bank ${bankDai}`);

    await brbC.write.approve([bankBrb, brbAmount + treasuryBrb], { account: deployer.account });
    await wait(await bankBrbC.write.deposit([brbAmount, deployer.account.address], { account: deployer.account }));
    console.log(`Deposited ${brbAmount} BRB wei → bank ${bankBrb}`);

    await wait(
        await brbC.write.transfer([deploy.addresses.jackpotTreasury, treasuryBrb], { account: deployer.account }),
    );
    console.log(`Sent ${treasuryBrb} BRB wei → jackpot treasury ${deploy.addresses.jackpotTreasury}`);
}

main();
