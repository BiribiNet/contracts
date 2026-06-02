import type { Address, Hex, PublicClient } from "viem";
import { encodeFunctionData, parseAbi } from "viem";

import {
    verifyContractWithDelay,
    type RouletteEngineImplCtorArgs,
    verifyRouletteEngineImplementation,
} from "./verifyWithEtherscan";

export const ERC1967_IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const FQ_ERC1967_PROXY = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy" as const;
const FQ_BEACON_PROXY = "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy" as const;
const FQ_SIDE_BET = "contracts/SideBet.sol:SideBet" as const;

const bankVaultInitAbi = parseAbi([
    "function initialize((address assetToken, string name, string symbol, uint32 marketId, address engine, address admin, uint256 minBet, address sideBetController) params) external",
]);

const engineInitAbi = parseAbi([
    "function initialize((address registry, address jackpotTreasury, address jackpotFunder, address infraRecipient, uint256 subscriptionId, uint32 callbackGasLimit, uint32 roundDuration, address admin, address upkeepScheduler) cfg) external",
]);

const sideBetInitAbi = parseAbi([
    "function initialize(address admin, address engine, address registry, uint32 minMultiplierBps_, uint32 maxMultiplierBps_) external",
]);

export type EngineProxyInitConfig = {
    registry: Address;
    jackpotTreasury: Address;
    jackpotFunder: Address;
    infraRecipient: Address;
    subscriptionId: bigint;
    callbackGasLimit: number;
    roundDuration: number;
    admin: Address;
    upkeepScheduler: Address;
};

export async function readErc1967Implementation(publicClient: PublicClient, proxy: Address): Promise<Address> {
    const slot = await publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT });
    return (`0x${slot.slice(-40)}`) as Address;
}

export function encodeEngineProxyInitData(cfg: EngineProxyInitConfig): Hex {
    return encodeFunctionData({
        abi: engineInitAbi,
        functionName: "initialize",
        args: [cfg],
    });
}

export function encodeSideBetProxyInitData(
    admin: Address,
    engine: Address,
    registry: Address,
    minMultiplierBps: number,
    maxMultiplierBps: number,
): Hex {
    return encodeFunctionData({
        abi: sideBetInitAbi,
        functionName: "initialize",
        args: [admin, engine, registry, minMultiplierBps, maxMultiplierBps],
    });
}

export type BankVaultInitParams = {
    assetToken: Address;
    name: string;
    symbol: string;
    marketId: number;
    engine: Address;
    admin: Address;
    minBet: bigint;
    sideBetController: Address;
};

export function encodeBankVaultProxyInitData(params: BankVaultInitParams): Hex {
    return encodeFunctionData({
        abi: bankVaultInitAbi,
        functionName: "initialize",
        args: [params],
    });
}

/** Matches `MarketRegistry.createMarket` share naming. */
export async function encodeBankVaultProxyInitDataFromAsset(
    publicClient: PublicClient,
    params: {
        asset: Address;
        marketId: number;
        engine: Address;
        bankAdmin: Address;
        minBet: bigint;
        sideBetController: Address;
    },
): Promise<Hex> {
    const erc20MetaAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
    const [assetName, assetSymbol] = await Promise.all([
        publicClient.readContract({ address: params.asset, abi: erc20MetaAbi, functionName: "name" }),
        publicClient.readContract({ address: params.asset, abi: erc20MetaAbi, functionName: "symbol" }),
    ]);
    return encodeBankVaultProxyInitData({
        assetToken: params.asset,
        name: `BRB ${assetName}`,
        symbol: `brb${assetSymbol}`,
        marketId: params.marketId,
        engine: params.engine,
        admin: params.bankAdmin,
        minBet: params.minBet,
        sideBetController: params.sideBetController,
    });
}

const bankReadAbi = parseAbi([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function marketId() view returns (uint32)",
    "function minBet() view returns (uint256)",
    "function ENGINE() view returns (address)",
    "function sideBetController() view returns (address)",
]);

/** Reconstruct vault proxy init calldata from an initialized bank (for re-verification). */
export async function encodeBankVaultProxyInitDataFromBank(
    publicClient: PublicClient,
    bank: Address,
    bankAdmin: Address,
): Promise<Hex> {
    const [name, symbol, marketId, minBet, engine, sideBetController] = await Promise.all([
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "name" }),
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "symbol" }),
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "marketId" }),
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "minBet" }),
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "ENGINE" }),
        publicClient.readContract({ address: bank, abi: bankReadAbi, functionName: "sideBetController" }),
    ]);
    const assetAbi = parseAbi(["function asset() view returns (address)"]);
    const assetToken = await publicClient.readContract({ address: bank, abi: assetAbi, functionName: "asset" });

    return encodeBankVaultProxyInitData({
        assetToken,
        name,
        symbol,
        marketId,
        engine,
        admin: bankAdmin,
        minBet,
        sideBetController,
    });
}

export async function verifyErc1967ProxyWithDelay(
    proxy: Address,
    implementation: Address,
    initData: Hex,
    delayMs: number,
): Promise<void> {
    await verifyContractWithDelay(proxy, [implementation, initData], delayMs, FQ_ERC1967_PROXY);
}

export async function verifyBeaconProxyWithDelay(
    proxy: Address,
    beacon: Address,
    initData: Hex,
    delayMs: number,
): Promise<void> {
    await verifyContractWithDelay(proxy, [beacon, initData], delayMs, FQ_BEACON_PROXY);
}

export async function verifySideBetImplementationWithDelay(implementation: Address, delayMs: number): Promise<void> {
    await verifyContractWithDelay(implementation, [], delayMs, FQ_SIDE_BET);
}

export type VerifyProtocolProxiesParams = {
    delayMs: number;
    engineProxy: Address;
    engineImplementation: Address;
    engineInitData: Hex;
    engineImplCtorArgs: RouletteEngineImplCtorArgs;
    engineLibraryMap: Record<string, string>;
    sideBetProxy: Address;
    sideBetImplementation: Address;
    sideBetInitData: Hex;
    vaultBeacon: Address;
    bankVaults: readonly { bank: Address; initData: Hex }[];
};

/**
 * Verify UUPS/transparent-style proxies after their implementations are verified.
 * Order: SideBet impl → RouletteEngine impl → ERC1967 proxies → BeaconProxy banks.
 */
export async function verifyProtocolProxies(p: VerifyProtocolProxiesParams): Promise<void> {
    await verifySideBetImplementationWithDelay(p.sideBetImplementation, p.delayMs);
    await verifyRouletteEngineImplementation(
        p.engineImplementation,
        p.engineImplCtorArgs,
        p.engineLibraryMap,
        p.delayMs,
    );
    await verifyErc1967ProxyWithDelay(p.engineProxy, p.engineImplementation, p.engineInitData, p.delayMs);
    await verifyErc1967ProxyWithDelay(p.sideBetProxy, p.sideBetImplementation, p.sideBetInitData, p.delayMs);
    for (const { bank, initData } of p.bankVaults) {
        await verifyBeaconProxyWithDelay(bank, p.vaultBeacon, initData, p.delayMs);
    }
}
