import { viem } from "hardhat";

const ROULETTE_LIB = "contracts/RouletteLib.sol:RouletteLib" as const;
const ROULETTE_BET_LIB = "contracts/libraries/RouletteBetLib.sol:RouletteBetLib" as const;
const JACKPOT_BATCH_LIB = "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib" as const;
const ROULETTE_BET_CODEC_LIB = "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib" as const;
const ROULETTE_PAYOUT_MUL_LIB = "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib" as const;
const ROULETTE_LIABILITY_MATH_LIB = "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib" as const;

/** Deploy linked libraries then `RouletteEngine` (external libs required by solc). */
export async function deployRouletteEngine(constructorArgs: readonly unknown[]) {
    const rouletteLib = await viem.deployContract("RouletteLib");
    const rouletteBetLib = await viem.deployContract("RouletteBetLib");
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib");
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib");

    const rouletteLiabilityMathLib = await viem.deployContract("RouletteLiabilityMathLib", [], {
        libraries: { [ROULETTE_LIB]: rouletteLib.address },
    });

    const rouletteBetCodecLib = await viem.deployContract("RouletteBetCodecLib", [], {
        libraries: { [ROULETTE_BET_LIB]: rouletteBetLib.address },
    });

    return viem.deployContract("RouletteEngine", constructorArgs as never, {
        libraries: {
            [ROULETTE_BET_LIB]: rouletteBetLib.address,
            [JACKPOT_BATCH_LIB]: jackpotBatchLib.address,
            [ROULETTE_BET_CODEC_LIB]: rouletteBetCodecLib.address,
            [ROULETTE_PAYOUT_MUL_LIB]: roulettePayoutMulLib.address,
            [ROULETTE_LIABILITY_MATH_LIB]: rouletteLiabilityMathLib.address,
        },
    });
}
