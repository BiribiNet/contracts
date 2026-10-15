import { viem } from "hardhat";

import type { Account, Address, Chain, PublicClient, WalletClient } from "viem";
import { parseAbi, toFunctionSelector, zeroAddress } from "viem";

/** Production KeystoneForwarder — verify at https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts */
export const CRE_KEYSTONE_FORWARDER_ARBITRUM_ONE =
    "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" as const;
export const CRE_KEYSTONE_FORWARDER_ARBITRUM_SEPOLIA =
    "0x76c9cf548b4179F8901cda1f8623568b58215E62" as const;
/** Ethereum Sepolia — verify in Chainlink Forwarder Directory before production. */
export const CRE_KEYSTONE_FORWARDER_ETHEREUM_SEPOLIA =
    "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" as const;

const PERFORM_UPKEEP_SELECTOR = toFunctionSelector("performUpkeep(bytes)");

const schedulerForwarderAbi = parseAbi(["function setForwarderAuthority(address forwarderAuthority) external"]);

export type CreAutomationDeployment = {
    automationReceiver: Address;
    creExecutionAuthority: Address;
    keystoneForwarder: Address;
};

export type DeployCreAutomationParams = {
    scheduler: Address;
    admin: Address;
    expectedWorkflowOwner?: Address;
    receiverOwner?: Address;
    keystoneForwarder: Address;
    wallet: WalletClient;
    publicClient: PublicClient;
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>;
};

/**
 * Deploys CRE bridge contracts and wires `UpkeepScheduler` to accept calls from `AutomationReceiver`.
 */
export async function deployCreAutomation(params: DeployCreAutomationParams): Promise<CreAutomationDeployment> {
    const { scheduler, admin, keystoneForwarder, wallet, publicClient, waitWrite } = params;
    const account = wallet.account;
    if (!account) throw new Error("deployCreAutomation: wallet has no account");
    const chain = publicClient.chain as Chain | undefined;

    if (params.expectedWorkflowOwner?.toLowerCase() === zeroAddress) throw new Error("Expected workflow owner cannot be zero");
    if (params.receiverOwner?.toLowerCase() === zeroAddress) throw new Error("Receiver owner cannot be zero");
    if (await publicClient.getChainId() === 42161 && !params.expectedWorkflowOwner) {
        throw new Error("Mainnet requires expectedWorkflowOwner before any CRE deployment");
    }

    const receiver = await viem.deployContract("AutomationReceiver", [keystoneForwarder], { account });
    const authority = await viem.deployContract("CreExecutionAuthority", [admin], { account });

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

    if (params.expectedWorkflowOwner) {
        await waitWrite(receiver.write.setExpectedAuthor([params.expectedWorkflowOwner], { account }));
    }

    await waitWrite(authority.write.setExecutorApproved([receiver.address, true], { account }));

    await waitWrite(
        receiver.write.setCallAllowed([scheduler, PERFORM_UPKEEP_SELECTOR, true], { account }),
    );

    if (params.receiverOwner && params.receiverOwner.toLowerCase() !== account.address.toLowerCase()) {
        await waitWrite(receiver.write.transferOwnership([params.receiverOwner], { account }));
    }

    if (params.expectedWorkflowOwner && (await receiver.read.getExpectedAuthor()).toLowerCase() !== params.expectedWorkflowOwner.toLowerCase()) throw new Error("CRE workflow owner binding failed");
    if ((await receiver.read.owner()).toLowerCase() !== (params.receiverOwner ?? account.address).toLowerCase()) throw new Error("CRE receiver ownership handoff failed");

    return {
        automationReceiver: receiver.address,
        creExecutionAuthority: authority.address,
        keystoneForwarder,
    };
}

/** Local / Hardhat stack: mock CRE forwarder + receiver for integration tests without CRE DON. */
export async function deployLocalCreAutomation(params: {
    scheduler: Address;
    admin: Address;
    wallet: WalletClient;
    publicClient: PublicClient;
    waitWrite: (hashPromise: Promise<`0x${string}`>) => Promise<void>;
}): Promise<CreAutomationDeployment> {
    const account = params.wallet.account;
    if (!account) throw new Error("deployLocalCreAutomation: wallet has no account");
    const mockForwarder = await viem.deployContract("MockCreForwarder", [], { account });
    return deployCreAutomation({
        ...params,
        keystoneForwarder: mockForwarder.address,
    });
}
