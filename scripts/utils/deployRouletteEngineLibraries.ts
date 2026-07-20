import { viem } from "hardhat";

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
};

export type RouletteEngineLibraryLinks = Record<string, Address>;

/** Deploys the linked libraries used by `RouletteEngine` (CREATE order matches deploy script). */
export async function deployRouletteEngineLibraries(account: Account): Promise<{
    addresses: RouletteEngineLibraryAddresses;
    engineLinks: RouletteEngineLibraryLinks;
}> {
    const rouletteLib = await viem.deployContract("RouletteLib", [], { account });
    const rouletteBetLib = await viem.deployContract("RouletteBetLib", [], { account });
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib", [], { account });
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib", [], { account });
    const rouletteExposureLib = await viem.deployContract("RouletteExposureLib", [], { account });
    const rouletteJackpotCollectLib = await viem.deployContract("RouletteJackpotCollectLib", [], { account });

    const roulettePayoutSweepLib = await viem.deployContract("RoulettePayoutSweepLib", [], {
        account,
        libraries: {
            [ROULETTE_BET_LIB]: rouletteBetLib.address,
            [ROULETTE_PAYOUT_MUL_LIB]: roulettePayoutMulLib.address,
        },
    });

    const rouletteLiabilityMathLib = await viem.deployContract("RouletteLiabilityMathLib", [], {
        account,
        libraries: { [ROULETTE_LIB]: rouletteLib.address },
    });

    const rouletteBetCodecLib = await viem.deployContract("RouletteBetCodecLib", [], {
        account,
        libraries: { [ROULETTE_BET_LIB]: rouletteBetLib.address },
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
    };

    const engineLinks: RouletteEngineLibraryLinks = {
        [JACKPOT_BATCH_LIB]: jackpotBatchLib.address,
        [ROULETTE_BET_CODEC_LIB]: rouletteBetCodecLib.address,
        [ROULETTE_LIABILITY_MATH_LIB]: rouletteLiabilityMathLib.address,
        [ROULETTE_PAYOUT_SWEEP_LIB]: roulettePayoutSweepLib.address,
        [ROULETTE_JACKPOT_COLLECT_LIB]: rouletteJackpotCollectLib.address,
        [ROULETTE_EXPOSURE_LIB]: rouletteExposureLib.address,
    };

    return { addresses, engineLinks };
}
