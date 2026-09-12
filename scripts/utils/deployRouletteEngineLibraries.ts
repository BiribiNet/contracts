import hre, { viem } from "hardhat";

import type { Account, Address } from "viem";

const ROULETTE_LIB = "contracts/RouletteLib.sol:RouletteLib" as const;
const ROULETTE_BET_LIB = "contracts/libraries/RouletteBetLib.sol:RouletteBetLib" as const;
const JACKPOT_BATCH_LIB = "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib" as const;
const ROULETTE_BET_CODEC_LIB = "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib" as const;
const ROULETTE_PAYOUT_MUL_LIB = "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib" as const;
const ROULETTE_LIABILITY_MATH_LIB = "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib" as const;
const ROULETTE_PAYOUT_SWEEP_LIB = "contracts/libraries/RoulettePayoutSweepLib.sol:RoulettePayoutSweepLib" as const;
const ROULETTE_JACKPOT_COLLECT_LIB = "contracts/libraries/RouletteJackpotCollectLib.sol:RouletteJackpotCollectLib" as const;
const ROULETTE_EXPOSURE_LIB = "contracts/libraries/RouletteExposureLib.sol:RouletteExposureLib" as const;
const ROULETTE_UPKEEP_SCAN_LIB = "contracts/libraries/RouletteUpkeepScanLib.sol:RouletteUpkeepScanLib" as const;

export type RouletteEngineLibraryAddresses = {
    rouletteLib: Address;
    rouletteBetLib: Address;
    jackpotBatchLib: Address;
    roulettePayoutMulLib: Address;
    rouletteLiabilityMathLib: Address;
    rouletteBetCodecLib: Address;
    roulettePayoutSweepLib: Address;
    rouletteJackpotCollectLib: Address;
    rouletteExposureLib: Address;
    rouletteUpkeepScanLib: Address;
};

export type RouletteEngineLibraryLinks = Record<string, Address>;

const CREATE_GAS = 8_000_000n;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableDeployError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /nonce too low|Internal error|replacement transaction underpriced|already known/i.test(msg);
}

async function deployLib(
    name: string,
    account: Account,
    libraries?: Record<string, Address>,
) {
    const live = hre.network.name !== "hardhat";
    const options = {
        account,
        ...(live ? { gas: CREATE_GAS } : {}),
        ...(libraries !== undefined ? { libraries } : {}),
    };

    const attempts = live ? 8 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            if (live && attempt > 0) await sleep(1500 * attempt);
            const deployed = await viem.deployContract(name, [], options);
            if (live) console.log(`  ${name}: ${deployed.address}`);
            return deployed;
        } catch (error) {
            if (!live || !isRetryableDeployError(error) || attempt === attempts - 1) throw error;
            console.warn(`Retry ${name} (${attempt + 1}/${attempts}): ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        }
    }
    throw new Error(`Failed to deploy ${name}`);
}

/** Deploys the linked libraries used by `RouletteEngine` (CREATE order matches deploy script). */
export async function deployRouletteEngineLibraries(account: Account): Promise<{
    addresses: RouletteEngineLibraryAddresses;
    engineLinks: RouletteEngineLibraryLinks;
}> {
    const rouletteLib = await deployLib("RouletteLib", account);
    const rouletteBetLib = await deployLib("RouletteBetLib", account);
    const jackpotBatchLib = await deployLib("JackpotBatchLib", account);
    const roulettePayoutMulLib = await deployLib("RoulettePayoutMulLib", account);
    const rouletteExposureLib = await deployLib("RouletteExposureLib", account);
    const rouletteJackpotCollectLib = await deployLib("RouletteJackpotCollectLib", account);

    const roulettePayoutSweepLib = await deployLib("RoulettePayoutSweepLib", account, {
        [ROULETTE_BET_LIB]: rouletteBetLib.address,
        [ROULETTE_PAYOUT_MUL_LIB]: roulettePayoutMulLib.address,
    });

    const rouletteLiabilityMathLib = await deployLib("RouletteLiabilityMathLib", account, {
        [ROULETTE_LIB]: rouletteLib.address,
    });

    const rouletteBetCodecLib = await deployLib("RouletteBetCodecLib", account, {
        [ROULETTE_BET_LIB]: rouletteBetLib.address,
    });

    const rouletteUpkeepScanLib = await deployLib("RouletteUpkeepScanLib", account, {
        [JACKPOT_BATCH_LIB]: jackpotBatchLib.address,
        [ROULETTE_JACKPOT_COLLECT_LIB]: rouletteJackpotCollectLib.address,
        [ROULETTE_PAYOUT_SWEEP_LIB]: roulettePayoutSweepLib.address,
    });

    const addresses: RouletteEngineLibraryAddresses = {
        rouletteLib: rouletteLib.address,
        rouletteBetLib: rouletteBetLib.address,
        jackpotBatchLib: jackpotBatchLib.address,
        roulettePayoutMulLib: roulettePayoutMulLib.address,
        rouletteLiabilityMathLib: rouletteLiabilityMathLib.address,
        rouletteBetCodecLib: rouletteBetCodecLib.address,
        roulettePayoutSweepLib: roulettePayoutSweepLib.address,
        rouletteJackpotCollectLib: rouletteJackpotCollectLib.address,
        rouletteExposureLib: rouletteExposureLib.address,
        rouletteUpkeepScanLib: rouletteUpkeepScanLib.address,
    };

    const engineLinks: RouletteEngineLibraryLinks = {
        [ROULETTE_BET_CODEC_LIB]: rouletteBetCodecLib.address,
        [ROULETTE_LIABILITY_MATH_LIB]: rouletteLiabilityMathLib.address,
        [ROULETTE_PAYOUT_SWEEP_LIB]: roulettePayoutSweepLib.address,
        [ROULETTE_JACKPOT_COLLECT_LIB]: rouletteJackpotCollectLib.address,
        [ROULETTE_EXPOSURE_LIB]: rouletteExposureLib.address,
        [ROULETTE_UPKEEP_SCAN_LIB]: rouletteUpkeepScanLib.address,
    };

    return { addresses, engineLinks };
}
