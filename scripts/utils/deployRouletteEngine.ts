import { viem } from "hardhat";
import { getContractAddress, type Address } from "viem";

const ROULETTE_LIB = "contracts/RouletteLib.sol:RouletteLib" as const;
const ROULETTE_BET_LIB = "contracts/libraries/RouletteBetLib.sol:RouletteBetLib" as const;
const JACKPOT_BATCH_LIB = "contracts/libraries/JackpotBatchLib.sol:JackpotBatchLib" as const;
const ROULETTE_BET_CODEC_LIB = "contracts/libraries/RouletteBetCodecLib.sol:RouletteBetCodecLib" as const;
const ROULETTE_PAYOUT_MUL_LIB = "contracts/libraries/RoulettePayoutMulLib.sol:RoulettePayoutMulLib" as const;
const ROULETTE_LIABILITY_MATH_LIB = "contracts/libraries/RouletteLiabilityMathLib.sol:RouletteLiabilityMathLib" as const;

export type UpkeepSchedulerDeployConfig = {
    admin: Address;
    scanLimit: number;
    maxPayoutsPerCall: number;
};

/**
 * Deploy linked libraries, `RouletteEngine` (immutable `UpkeepScheduler`), then `UpkeepScheduler`.
 * The scheduler address is the default-wallet next CREATE after the engine (computed from nonce).
 *
 * @param engineConstructorArgs `RouletteEngine` constructor args **without** trailing `upkeepScheduler` (11 args).
 */
export async function deployRouletteEngine(
    engineConstructorArgs: readonly unknown[],
    scheduler: UpkeepSchedulerDeployConfig,
) {
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const account = deployer.account;

    const rouletteLib = await viem.deployContract("RouletteLib", [], { account });
    const rouletteBetLib = await viem.deployContract("RouletteBetLib", [], { account });
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib", [], { account });
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib", [], { account });

    const rouletteLiabilityMathLib = await viem.deployContract("RouletteLiabilityMathLib", [], {
        account,
        libraries: { [ROULETTE_LIB]: rouletteLib.address },
    });

    const rouletteBetCodecLib = await viem.deployContract("RouletteBetCodecLib", [], {
        account,
        libraries: { [ROULETTE_BET_LIB]: rouletteBetLib.address },
    });

    const nonceBeforeEngine = BigInt(
        await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    );
    const upkeepSchedulerAddress = getContractAddress({
        from: account.address,
        nonce: nonceBeforeEngine + 1n,
    });

    const engine = await viem.deployContract(
        "RouletteEngine",
        [...engineConstructorArgs, upkeepSchedulerAddress] as never,
        {
            account,
            libraries: {
                [ROULETTE_BET_LIB]: rouletteBetLib.address,
                [JACKPOT_BATCH_LIB]: jackpotBatchLib.address,
                [ROULETTE_BET_CODEC_LIB]: rouletteBetCodecLib.address,
                [ROULETTE_PAYOUT_MUL_LIB]: roulettePayoutMulLib.address,
                [ROULETTE_LIABILITY_MATH_LIB]: rouletteLiabilityMathLib.address,
            },
        },
    );

    const schedulerContract = await viem.deployContract(
        "UpkeepScheduler",
        [engine.address, scheduler.admin, scheduler.scanLimit, scheduler.maxPayoutsPerCall],
        { account },
    );

    if (schedulerContract.address.toLowerCase() !== upkeepSchedulerAddress.toLowerCase()) {
        throw new Error(
            `UpkeepScheduler CREATE mismatch: expected ${upkeepSchedulerAddress} got ${schedulerContract.address}`,
        );
    }

    return { engine, scheduler: schedulerContract };
}
