import { viem } from "hardhat";
import { parseAbi, type Address, type PublicClient, type WalletClient } from "viem";

import { vrfCreateSubscription, vrfFundSubscriptionWithLink } from "./vrfSubscription";

const tokenAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
]);

export function gasShortfall(balance: bigint, target: bigint): bigint {
    if (balance < 0n || target < 0n) throw new Error("Negative gas balance or target");
    return balance < target ? target - balance : 0n;
}

/** Funds only approved shortfalls; each transaction is confirmed by the caller before continuing. */
export async function topUpGasWallets(params: {
    deployer: WalletClient; client: PublicClient;
    recipients: Array<{ name: string; address: Address; target: bigint }>;
    waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    if (!params.deployer.account) throw new Error("Deployment signer missing");
    const records: Array<{ name: string; address: Address; amountWei: string; balanceBeforeWei: string; targetWei: string; hash?: `0x${string}` }> = [];
    for (const recipient of params.recipients) {
        const balance = await params.client.getBalance({ address: recipient.address });
        const amount = gasShortfall(balance, recipient.target);
        let hash: `0x${string}` | undefined;
        if (amount > 0n) {
            hash = await params.deployer.sendTransaction({ account: params.deployer.account,
                chain: params.client.chain, to: recipient.address, value: amount,
                gas: await params.client.estimateGas({ account: params.deployer.account, to: recipient.address, value: amount }) });
            await params.waitWrite(Promise.resolve(hash));
        }
        const funded = await params.client.getBalance({ address: recipient.address });
        if (funded < recipient.target) throw new Error(`Gas top-up did not reach target for ${recipient.name}`);
        records.push({ name: recipient.name, address: recipient.address, amountWei: amount.toString(), balanceBeforeWei: balance.toString(), targetWei: recipient.target.toString(), ...(hash ? { hash } : {}) });
    }
    return records;
}

/** Stakes the exact infrastructure genesis allocation; infra signs and owns all resulting vault shares. */
export async function stakeInfrastructureBrb(params: {
    token: Address; bank: Address; infrastructure: WalletClient; client: PublicClient; amount: bigint;
    waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    const account = params.infrastructure.account;
    if (!account) throw new Error("Infrastructure signing account missing");
    const before = await params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [account.address] });
    if (before !== params.amount) throw new Error("Infrastructure BRB balance must equal its exact genesis allocation before staking");
    const bank = await viem.getContractAt("BankVault4626", params.bank);
    if ((await bank.read.asset()).toLowerCase() !== params.token.toLowerCase()) throw new Error("BRB bank asset mismatch");
    const initialAssets = await bank.read.totalAssets();
    const initialShares = await bank.read.balanceOf([account.address]);
    const approveHash = await params.infrastructure.writeContract({ account, chain: params.client.chain,
        address: params.token, abi: tokenAbi, functionName: "approve", args: [params.bank, params.amount],
        gas: await params.client.estimateContractGas({ account, address: params.token, abi: tokenAbi, functionName: "approve", args: [params.bank, params.amount] }) });
    await params.waitWrite(Promise.resolve(approveHash));
    const depositHash = await params.infrastructure.writeContract({ account, chain: params.client.chain,
        address: params.bank, abi: bank.abi, functionName: "deposit", args: [params.amount, account.address],
        gas: await params.client.estimateContractGas({ account, address: params.bank, abi: bank.abi, functionName: "deposit", args: [params.amount, account.address] }) });
    await params.waitWrite(Promise.resolve(depositHash));
    const [remaining, assets, shares, allowance] = await Promise.all([
        params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [account.address] }),
        bank.read.totalAssets(), bank.read.balanceOf([account.address]),
        params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "allowance", args: [account.address, params.bank] }),
    ]);
    if (remaining !== 0n || assets - initialAssets !== params.amount || shares <= initialShares || allowance !== 0n) {
        throw new Error("Infrastructure staking read-back failed");
    }
    return { owner: account.address, assets: params.amount.toString(), shares: (shares - initialShares).toString(), approveHash, depositHash };
}

/** Marketing signs both transfers. Its reserve remains available after funding the house bot. */
export async function fundHouseBot(params: {
    token: Address; marketing: WalletClient; houseBot: Address; client: PublicClient;
    brbAmount: bigint; ethTarget: bigint; marketingEthReserve: bigint;
    waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    const account = params.marketing.account;
    if (!account) throw new Error("Marketing signing account missing");
    if (account.address.toLowerCase() === params.houseBot.toLowerCase() || BigInt(params.houseBot) === 0n) throw new Error("House bot must be a distinct nonzero wallet");
    if (params.brbAmount <= 0n) throw new Error("House bot BRB funding must be positive");
    const before = await params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [params.houseBot] });
    const marketingBefore = await params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [account.address] });
    if (marketingBefore < params.brbAmount) throw new Error("Marketing has insufficient BRB for house bot");
    const brbHash = await params.marketing.writeContract({ account, chain: params.client.chain,
        address: params.token, abi: tokenAbi, functionName: "transfer", args: [params.houseBot, params.brbAmount],
        gas: await params.client.estimateContractGas({ account, address: params.token, abi: tokenAbi, functionName: "transfer", args: [params.houseBot, params.brbAmount] }) });
    await params.waitWrite(Promise.resolve(brbHash));
    const gasFunding = await topUpGasWallets({ deployer: params.marketing, client: params.client,
        recipients: [{ name: "house_bot", address: params.houseBot, target: params.ethTarget }], waitWrite: params.waitWrite });
    const after = await params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [params.houseBot] });
    const marketingAfter = await params.client.readContract({ address: params.token, abi: tokenAbi, functionName: "balanceOf", args: [account.address] });
    if (after - before !== params.brbAmount || marketingBefore - marketingAfter !== params.brbAmount) throw new Error("House bot BRB transfer read-back failed");
    if (await params.client.getBalance({ address: account.address }) < params.marketingEthReserve) throw new Error("Marketing ETH reserve below target after house bot funding");
    return { source: account.address, houseBot: params.houseBot, brbAmount: params.brbAmount.toString(),
        marketingBrbRemaining: marketingAfter.toString(), brbHash, gasFunding };
}

/** Deployer transfers its entire LINK balance; infrastructure owns and funds the new subscription. */
export async function createInfrastructureVrfSubscription(params: {
    deployer: WalletClient; infrastructure: WalletClient; client: PublicClient;
    link: Address; coordinator: Address; waitWrite: (hash: Promise<`0x${string}`>) => Promise<void>;
}) {
    const sender = params.deployer.account;
    const owner = params.infrastructure.account;
    if (!sender || !owner || sender.address.toLowerCase() === owner.address.toLowerCase()) throw new Error("VRF requires distinct deployer and infrastructure signers");
    const readBalance = (address: Address) => params.client.readContract({ address: params.link, abi: tokenAbi, functionName: "balanceOf", args: [address] });
    const amount = await readBalance(sender.address);
    const infraBefore = await readBalance(owner.address);
    if (amount === 0n) throw new Error("Deployer has no LINK to transfer for VRF");
    const transferHash = await params.deployer.writeContract({ account: sender, chain: params.client.chain,
        address: params.link, abi: tokenAbi, functionName: "transfer", args: [owner.address, amount],
        gas: await params.client.estimateContractGas({ account: sender, address: params.link, abi: tokenAbi, functionName: "transfer", args: [owner.address, amount] }) });
    await params.waitWrite(Promise.resolve(transferHash));
    if (await readBalance(sender.address) !== 0n || await readBalance(owner.address) !== infraBefore + amount) throw new Error("LINK transfer to infrastructure read-back failed");
    const subscriptionId = await vrfCreateSubscription(params.infrastructure, params.client, params.coordinator);
    await vrfFundSubscriptionWithLink(params.infrastructure, params.client, params.link, params.coordinator, subscriptionId, amount);
    const subscription = await params.client.readContract({ address: params.coordinator,
        abi: parseAbi(["function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address owner,address[] consumers)"]),
        functionName: "getSubscription", args: [subscriptionId] });
    if (subscription[3].toLowerCase() !== owner.address.toLowerCase() || subscription[0] !== amount || await readBalance(owner.address) !== infraBefore) throw new Error("Infrastructure VRF owner/funding read-back failed");
    return { owner: owner.address, subscriptionId, fundedJuels: amount, transferHash };
}
