import { viem } from "hardhat";

import type { Address, Chain, PublicClient, WalletClient } from "viem";
import { parseAbi } from "viem";

const schedulerForwarderAbi = parseAbi([
    "function setForwarderAuthority(address forwarderAuthority) external",
]);

export type KeeperAutomationDeployment = {
    creExecutionAuthority: Address;
    keeper: Address;
};

/**
 * Keeper-only automation (Cloudflare Workers `EXECUTION_MODE=keeper`):
 * deploys `CreExecutionAuthority`, wires the scheduler, and approves the keeper EOA.
 * Does not deploy `AutomationReceiver` or depend on Chainlink CRE.
 */
export async function deployKeeperAutomation(params: {
    scheduler: Address;
    admin: Address;
    keeper: Address;
    wallet: WalletClient;
    publicClient: PublicClient;
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>;
}): Promise<KeeperAutomationDeployment> {
    const { scheduler, admin, keeper, wallet, publicClient, waitWrite } = params;
    const account = wallet.account;
    if (!account) throw new Error("deployKeeperAutomation: wallet has no account");
    if (BigInt(keeper) === 0n) throw new Error("keeper cannot be zero");
    if (BigInt(admin) === 0n) throw new Error("admin cannot be zero");

    const chain = publicClient.chain as Chain | undefined;
    const authority = await viem.deployContract("CreExecutionAuthority", [admin], { client: { wallet: await viem.getWalletClient(account.address) } });

    await waitWrite(
        wallet.writeContract({
            address: scheduler,
            abi: schedulerForwarderAbi,
            functionName: "setForwarderAuthority",
            args: [authority.address],
            account,
            chain,
        }),
    );

    await waitWrite(authority.write.setExecutorApproved([keeper, true], { account }));

    if (!(await authority.read.isApprovedAutomationForwarder([keeper]))) {
        throw new Error("Keeper executor approval did not persist");
    }

    return { creExecutionAuthority: authority.address, keeper };
}
