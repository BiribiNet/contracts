import { getContractAddress, type Address } from "viem";

/** Library CREATE count inside `deployRouletteEngine` before the engine implementation. */
const ROULETTE_ENGINE_LIBRARY_COUNT = 9n;

export type PredictRouletteStackOptions = {
    deployBrbReferral?: boolean;
};

/**
 * Predicts engine / side-bet / scheduler proxy addresses from the nonce at the first library CREATE.
 *
 * Deployment order before `deployRouletteEngine` (typical test helper):
 * `BRBToken` → `MockVrfCoordinator` → `MockUniswapV2Router` → `JackpotTreasury` → `BRBJackpotFunder` → `MarketRegistry`,
 * then 9 linked libraries and the CREATE sequence inside `deployRouletteEngine`.
 */
export function predictRouletteStackAddresses(
    from: Address,
    nonceBeforeTreasury: bigint,
    options: PredictRouletteStackOptions = {},
): { engineProxy: Address; sideBetProxy: Address; upkeepScheduler: Address } {
    const nonceBeforeImpl = nonceBeforeTreasury + 3n + ROULETTE_ENGINE_LIBRARY_COUNT;
    const referralOffset = options.deployBrbReferral ? 1n : 0n;
    const engineProxy = getContractAddress({ from, nonce: nonceBeforeImpl + 1n + referralOffset });
    const sideBetProxy = getContractAddress({ from, nonce: nonceBeforeImpl + 3n + referralOffset });
    const upkeepScheduler = getContractAddress({ from, nonce: nonceBeforeImpl + 4n + referralOffset });
    return { engineProxy, sideBetProxy, upkeepScheduler };
}

/** Predicts SideBet proxy address from `SideBet` implementation CREATE at `nonceBeforeSideBetImpl`. */
export function predictSideBetProxyAddress(from: Address, nonceBeforeSideBetImpl: bigint): Address {
    return getContractAddress({ from, nonce: nonceBeforeSideBetImpl + 1n });
}
