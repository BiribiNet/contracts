import hre from "hardhat";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlreadyVerifiedMessage(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes("already verified") || m.includes("contract source code already verified");
}

/**
 * Best-effort Arbiscan/Etherscan verification. Requires `ETHERSCAN_API_KEY` in Hardhat vars.
 * @param contract Fully qualified name when multiple contracts share the same flattened name.
 * @param libraries Required when the deployed bytecode links other library contracts.
 */
export async function verifyContract(
    address: `0x${string}`,
    constructorArguments: unknown[],
    contract?: string,
    libraries?: Record<string, string>,
): Promise<void> {
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
            ...(contract !== undefined ? { contract } : {}),
            ...(libraries !== undefined && Object.keys(libraries).length > 0 ? { libraries } : {}),
        });
        console.log(`Verified ${address}`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyVerifiedMessage(msg)) {
            console.log(`Skip verify (already verified): ${address}`);
            return;
        }
        throw e;
    }
}

/**
 * Verify `UpgradeableBeacon`. OpenZeppelin's hardhat-upgrades hook treats beacon addresses specially and
 * calls Etherscan log APIs without API v2 `chainid` (Hardhat #…); use explicit FQN and swallow that path's failure.
 */
export async function verifyUpgradeableBeaconWithDelay(
    beacon: `0x${string}`,
    constructorArguments: [implementation: `0x${string}`, owner: `0x${string}`],
    delayMs: number,
): Promise<void> {
    try {
        await verifyContractWithDelay(beacon, constructorArguments, delayMs, FQ_UPGRADEABLE_BEACON);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Missing chainid parameter") || msg.includes("Failed to get logs")) {
            console.warn(
                `Beacon ${beacon} verification skipped (Etherscan v2 + OZ upgrades log lookup). ` +
                    `Verify manually on Arbiscan: UpgradeableBeacon(${constructorArguments[0]}, ${constructorArguments[1]}).`,
            );
            return;
        }
        throw e;
    }
}

export async function verifyContractWithDelay(
    address: `0x${string}`,
    constructorArguments: unknown[],
    delayMs: number,
    contract?: string,
    libraries?: Record<string, string>,
): Promise<void> {
    await verifyContract(address, constructorArguments, contract, libraries);
    if (delayMs > 0) await sleep(delayMs);
}

const FQ_UPGRADEABLE_BEACON =
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon" as const;
const FQ_ROULETTE_ENGINE = "contracts/RouletteEngine.sol:RouletteEngine" as const;
const FQ_ROULETTE_LIB = "contracts/RouletteLib.sol:RouletteLib" as const;
const FQ_ROULETTE_BET_LIB = "contracts/libraries/RouletteBetLib.sol:RouletteBetLib" as const;
const FQ_ROULETTE_PAYOUT_MUL_LIB = "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib" as const;

export type RouletteLinkedLibraries = {
    rouletteLib: `0x${string}`;
    rouletteBetLib: `0x${string}`;
    jackpotBatchLib: `0x${string}`;
    roulettePayoutMulLib: `0x${string}`;
    rouletteLiabilityMathLib: `0x${string}`;
    rouletteBetCodecLib: `0x${string}`;
    roulettePayoutSweepLib: `0x${string}`;
    rouletteJackpotCollectLib: `0x${string}`;
    rouletteExposureLib: `0x${string}`;
    rouletteUpkeepScanLib: `0x${string}`;
};

/** Library map passed to `RouletteEngine` implementation verification. */
export function buildRouletteEngineLibraryMap(linked: RouletteLinkedLibraries): Record<string, string> {
    return {
        "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib": linked.jackpotBatchLib,
        "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib": linked.rouletteBetCodecLib,
        "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib": linked.rouletteExposureLib,
        "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib":
            linked.rouletteJackpotCollectLib,
        "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib": linked.rouletteLiabilityMathLib,
        "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib": linked.roulettePayoutSweepLib,
        "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib": linked.rouletteUpkeepScanLib,
    };
}

/** Verify leaf libs first, then libs deployed with library links. */
export async function verifyRouletteLinkedLibraries(linked: RouletteLinkedLibraries, delayMs: number): Promise<void> {
    await verifyContractWithDelay(linked.rouletteLib, [], delayMs);
    await verifyContractWithDelay(linked.rouletteBetLib, [], delayMs);
    await verifyContractWithDelay(linked.jackpotBatchLib, [], delayMs);
    await verifyContractWithDelay(linked.roulettePayoutMulLib, [], delayMs);
    await verifyContractWithDelay(linked.rouletteExposureLib, [], delayMs);
    await verifyContractWithDelay(linked.rouletteUpkeepScanLib, [], delayMs);
    await verifyContractWithDelay(linked.rouletteJackpotCollectLib, [], delayMs);
    await verifyContractWithDelay(linked.rouletteLiabilityMathLib, [], delayMs, undefined, {
        [FQ_ROULETTE_LIB]: linked.rouletteLib,
    });
    await verifyContractWithDelay(linked.rouletteBetCodecLib, [], delayMs, undefined, {
        [FQ_ROULETTE_BET_LIB]: linked.rouletteBetLib,
    });
    await verifyContractWithDelay(linked.roulettePayoutSweepLib, [], delayMs, undefined, {
        [FQ_ROULETTE_BET_LIB]: linked.rouletteBetLib,
        [FQ_ROULETTE_PAYOUT_MUL_LIB]: linked.roulettePayoutMulLib,
    });
}

export type RouletteEngineImplCtorArgs = readonly [
    vrfCoordinator: `0x${string}`,
    vrfKeyHash2Gwei: `0x${string}`,
    vrfKeyHash30Gwei: `0x${string}`,
    vrfKeyHash150Gwei: `0x${string}`,
    vrfConfirmations: number,
    brbReferral: `0x${string}`,
];

/** Verify UUPS implementation (not the proxy). Proxy constructor is `(implementation, initData)`. */
export async function verifyRouletteEngineImplementation(
    implementation: `0x${string}`,
    constructorArguments: RouletteEngineImplCtorArgs,
    libraries: Record<string, string>,
    delayMs: number,
): Promise<void> {
    try {
        await hre.run("verify:verify", {
            address: implementation,
            constructorArguments: [...constructorArguments],
            contract: FQ_ROULETTE_ENGINE,
            libraries,
        });
        console.log(`Verified RouletteEngine implementation ${implementation}`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyVerifiedMessage(msg)) {
            console.log(`Skip verify (already verified): ${implementation}`);
            return;
        }
        throw e;
    }
    if (delayMs > 0) await sleep(delayMs);
}

/** @deprecated Use `verifyRouletteEngineImplementation` for UUPS deployments. */
export async function verifyRouletteEngine(
    address: `0x${string}`,
    constructorArguments: unknown[],
    libraries: Record<string, string>,
    delayMs: number,
): Promise<void> {
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
            libraries,
        });
        console.log(`Verified RouletteEngine ${address}`);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyVerifiedMessage(msg)) {
            console.log(`Skip verify (already verified): ${address}`);
            return;
        }
        throw e;
    }
    if (delayMs > 0) await sleep(delayMs);
}
