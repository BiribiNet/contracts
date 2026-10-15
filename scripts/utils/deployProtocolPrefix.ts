import { viem } from "hardhat";
import { type Address } from "viem";
import { predictRouletteStackAddresses, type PredictRouletteStackOptions } from "./predictDeployAddresses";

export type DeployProtocolPrefixParams = {
    admin: Address;
    brb: Address;
    mockRouter: Address;
} & PredictRouletteStackOptions;

/**
 * @deprecated Prefer `deployRouletteEngine` with `options.protocolPrefix`.
 * Kept for deploy scripts that deploy treasury / funder / registry before the engine stack.
 */
export async function deployProtocolPrefix(params: DeployProtocolPrefixParams) {
    const publicClient = await viem.getPublicClient();
    const nonceBeforeTreasury = BigInt(
        await publicClient.getTransactionCount({ address: params.admin, blockTag: "latest" }),
    );
    const { engineProxy, sideBetProxy, upkeepScheduler } = predictRouletteStackAddresses(
        params.admin,
        nonceBeforeTreasury,
        { deployBrbReferral: params.deployBrbReferral },
    );

    const jackpotTreasury = await viem.deployContract("JackpotTreasury", [
        params.brb,
        engineProxy,
        params.admin,
    ]);
    const funder = await viem.deployContract("BRBJackpotFunder", [
        engineProxy,
        params.brb,
        params.mockRouter,
        jackpotTreasury.address,
        sideBetProxy,
        params.admin,
    ]);
    const registry = await viem.deployContract("MarketRegistry", [params.admin, engineProxy, sideBetProxy]);

    return { jackpotTreasury, funder, registry, engineProxy, sideBetProxy, upkeepScheduler, nonceBeforeTreasury };
}
