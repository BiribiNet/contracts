import { viem } from "hardhat";
import { encodeFunctionData, getContractAddress, type Address } from "viem";

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

export type UpkeepSchedulerDeployConfig = {
    admin: Address;
    scanLimit: number;
    maxPayoutsPerCall: number;
};

/**
 * Deploy linked libraries, `RouletteEngine` implementation + `ERC1967Proxy` (`initialize`), then `UpkeepScheduler`.
 * Scheduler address is predicted as the third CREATE after the implementation (impl → proxy → scheduler).
 *
 * @param vrfLaneKeyHashes Three Chainlink VRF key hashes (2 / 30 / 150 gwei lanes); engine picks by `tx.gasprice` like legacy `OldRouletteClean`.
 * @param engineConstructorArgs `[registry, jackpotTreasury, jackpotFunder, infraRecipient, vrfCoordinator, subscriptionId, callbackGasLimit, confirmations, roundDuration, admin]` (10 args).
 */
export async function deployRouletteEngine(
    vrfLaneKeyHashes: readonly [`0x${string}`, `0x${string}`, `0x${string}`],
    engineConstructorArgs: readonly unknown[],
    scheduler: UpkeepSchedulerDeployConfig,
) {
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const account = deployer.account;

    if (engineConstructorArgs.length !== 10) {
        throw new Error(
            `deployRouletteEngine: expected 10 engineConstructorArgs (registry … admin), got ${engineConstructorArgs.length}`,
        );
    }

    const rouletteLib = await viem.deployContract("RouletteLib", [], { account });
    const rouletteBetLib = await viem.deployContract("RouletteBetLib", [], { account });
    const jackpotBatchLib = await viem.deployContract("JackpotBatchLib", [], { account });
    const roulettePayoutMulLib = await viem.deployContract("RoulettePayoutMulLib", [], { account });
    const rouletteExposureLib = await viem.deployContract("RouletteExposureLib", [], { account });
    const rouletteUpkeepScanLib = await viem.deployContract("RouletteUpkeepScanLib", [], { account });
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

    const libraryLinks = {
        [JACKPOT_BATCH_LIB]: jackpotBatchLib.address,
        [ROULETTE_BET_CODEC_LIB]: rouletteBetCodecLib.address,
        [ROULETTE_LIABILITY_MATH_LIB]: rouletteLiabilityMathLib.address,
        [ROULETTE_PAYOUT_SWEEP_LIB]: roulettePayoutSweepLib.address,
        [ROULETTE_JACKPOT_COLLECT_LIB]: rouletteJackpotCollectLib.address,
        [ROULETTE_EXPOSURE_LIB]: rouletteExposureLib.address,
        [ROULETTE_UPKEEP_SCAN_LIB]: rouletteUpkeepScanLib.address,
    };

    const vrfCoordinator = engineConstructorArgs[4];
    const vrfTuple = {
        keyHash2Gwei: vrfLaneKeyHashes[0],
        keyHash30Gwei: vrfLaneKeyHashes[1],
        keyHash150Gwei: vrfLaneKeyHashes[2],
    };

    const nonceBeforeImpl = BigInt(
        await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    );
    const upkeepSchedulerAddress = getContractAddress({
        from: account.address,
        nonce: nonceBeforeImpl + 2n,
    });

    const engineImplementation = await viem.deployContract("RouletteEngine", [vrfCoordinator] as never, {
        account,
        libraries: libraryLinks,
    });

    const initData = encodeFunctionData({
        abi: engineImplementation.abi,
        functionName: "initialize",
        args: [
            {
                registry: engineConstructorArgs[0],
                jackpotTreasury: engineConstructorArgs[1],
                jackpotFunder: engineConstructorArgs[2],
                infraRecipient: engineConstructorArgs[3],
                subscriptionId: engineConstructorArgs[5],
                vrfLaneKeyHashes: vrfTuple,
                callbackGasLimit: engineConstructorArgs[6],
                confirmations: engineConstructorArgs[7],
                roundDuration: engineConstructorArgs[8],
                admin: engineConstructorArgs[9],
                upkeepScheduler: upkeepSchedulerAddress,
            },
        ],
    });

    const proxy = await viem.deployContract("ERC1967Proxy", [engineImplementation.address, initData], { account });

    const engine = await viem.getContractAt("RouletteEngine", proxy.address);

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

    return {
        engine,
        engineImplementation,
        scheduler: schedulerContract,
        linkedLibraries: {
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
        },
    };
}
