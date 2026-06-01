import { viem } from "hardhat";

import { encodeFunctionData, type Address } from "viem";

import { predictSideBetProxyAddress } from "../../scripts/utils/predictDeployAddresses";

export type DeploySideBetRegistryStackParams = {
    admin: Address;
    roundEngine: Address;
};

/**
 * Deploys `MarketRegistry` wired to a predicted SideBet proxy address.
 * Call `deploySideBetProxy` immediately after (no intervening txs), then `setVaultBeacon` / other setup.
 */
export async function deploySideBetRegistryStack(params: DeploySideBetRegistryStackParams) {
    const publicClient = await viem.getPublicClient();
    const nonceBeforeRegistry = BigInt(
        await publicClient.getTransactionCount({ address: params.admin, blockTag: "latest" }),
    );
    const sideBetProxy = predictSideBetProxyAddress(params.admin, nonceBeforeRegistry + 1n);
    const registry = await viem.deployContract("MarketRegistry", [
        params.admin,
        params.roundEngine,
        sideBetProxy,
    ]);

    return { registry, sideBetProxy, nonceBeforeRegistry };
}

export type DeploySideBetProxyParams = {
    admin: Address;
    roundEngine: Address;
    registry: Address;
    minMultiplierBps: number;
    maxMultiplierBps: number;
};

export async function deploySideBetProxy(params: DeploySideBetProxyParams) {
    const sideBetImpl = await viem.deployContract("SideBet");
    const initData = encodeFunctionData({
        abi: sideBetImpl.abi,
        functionName: "initialize",
        args: [
            params.admin,
            params.roundEngine,
            params.registry,
            params.minMultiplierBps,
            params.maxMultiplierBps,
        ],
    });
    const proxy = await viem.deployContract("ERC1967Proxy", [sideBetImpl.address, initData]);
    return { sideBet: await viem.getContractAt("SideBet", proxy.address), sideBetImpl };
}

/** Registry + SideBet proxy with correct nonce ordering; optional beacon set after. */
export async function deploySideBetRegistryAndProxy(
    params: DeploySideBetRegistryStackParams & Omit<DeploySideBetProxyParams, "registry">,
) {
    const { registry, sideBetProxy, nonceBeforeRegistry } = await deploySideBetRegistryStack(params);
    const { sideBet, sideBetImpl } = await deploySideBetProxy({
        ...params,
        registry: registry.address,
    });
    return { registry, sideBet, sideBetImpl, sideBetProxy, nonceBeforeRegistry };
}
