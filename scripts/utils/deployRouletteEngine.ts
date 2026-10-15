import { network, viem } from "hardhat";
import { encodeFunctionData, getContractAddress, zeroAddress, type Address, type Hex } from "viem";
import { deployRouletteEngineLibraries } from "./deployRouletteEngineLibraries";
import { predictRouletteStackAddresses } from "./predictDeployAddresses";

const DEFAULT_SIDE_BET_MIN_MULTIPLIER_BPS = 50_000;
const DEFAULT_SIDE_BET_MAX_MULTIPLIER_BPS = 5_000_000;

export type UpkeepSchedulerDeployConfig = {
    admin: Address;
    scanLimit: number;
    maxPayoutsPerCall: number;
};

export type DeployRouletteEngineOptions = {
    /** Pre-deployed referral token wired into the implementation constructor. */
    brbReferral?: Address;
    /** Deploy `BRBReferal` against the predicted engine proxy address before the implementation. */
    deployBrbReferral?: boolean;
    sideBetMinMultiplierBps?: number;
    sideBetMaxMultiplierBps?: number;
    /**
     * When true (default), deploys `MockUpkeepForwarderAuthority` so tests can call `performUpkeep` directly.
     * Production deploy scripts must pass `false` and wire `CreExecutionAuthority` via `setForwarderAuthority` once.
     */
    wireMockForwarder?: boolean;
    /** When set, deploys treasury / funder / registry immediately before linked libraries using predicted proxy addresses. */
    protocolPrefix?: {
        brb: Address;
        router: Address;
        admin: Address;
    };
};

/**
 * Deploy linked libraries, `RouletteEngine` implementation + `ERC1967Proxy` (`initialize`), `SideBet` proxy, then `UpkeepScheduler`.
 * Scheduler address is predicted as the last CREATE after optional `BRBReferal`
 * (referral → engine impl → engine proxy → side-bet impl → side-bet proxy → scheduler).
 *
 * @param vrfLaneKeyHashes Three Chainlink VRF key hashes (2 / 30 / 150 gwei lanes); engine picks by `tx.gasprice` like legacy `OldRouletteClean`.
 * @param engineConstructorArgs `[registry, jackpotTreasury, jackpotFunder, infraRecipient, vrfCoordinator, subscriptionId, callbackGasLimit, confirmations, roundDuration, admin]` (10 args).
 */
export async function deployRouletteEngine(
    vrfLaneKeyHashes: readonly [`0x${string}`, `0x${string}`, `0x${string}`],
    engineConstructorArgs: readonly unknown[],
    scheduler: UpkeepSchedulerDeployConfig,
    options: DeployRouletteEngineOptions = {},
) {
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const account = deployer.account;

    if (engineConstructorArgs.length !== 10) {
        throw new Error(
            `deployRouletteEngine: expected 10 engineConstructorArgs (registry … admin), got ${engineConstructorArgs.length}`,
        );
    }

    if (network.name !== "hardhat" && options.wireMockForwarder !== false) {
        throw new Error("Live deployments must explicitly disable the test forwarder");
    }
    const registryAddress = engineConstructorArgs[0] as Address;
    const sideBetMinMultiplierBps = options.sideBetMinMultiplierBps ?? DEFAULT_SIDE_BET_MIN_MULTIPLIER_BPS;
    const sideBetMaxMultiplierBps = options.sideBetMaxMultiplierBps ?? DEFAULT_SIDE_BET_MAX_MULTIPLIER_BPS;

    let jackpotTreasuryAddress = engineConstructorArgs[1] as Address;
    let jackpotFunderAddress = engineConstructorArgs[2] as Address;
    let wiredRegistryAddress = registryAddress;

    if (options.protocolPrefix) {
        const prefix = options.protocolPrefix;
        const nonceBeforePrefix = BigInt(
            await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        );
        const { engineProxy, sideBetProxy } = predictRouletteStackAddresses(account.address, nonceBeforePrefix, {
            deployBrbReferral: options.deployBrbReferral,
        });

        const jackpotTreasury = await viem.deployContract(
            "JackpotTreasury",
            [prefix.brb, engineProxy, prefix.admin],
            { client: { wallet: deployer } },
        );
        const funder = await viem.deployContract(
            "BRBJackpotFunder",
            [engineProxy, prefix.brb, prefix.router, jackpotTreasury.address, sideBetProxy, prefix.admin],
            { client: { wallet: deployer } },
        );
        const registry = await viem.deployContract(
            "MarketRegistry",
            [prefix.admin, engineProxy, sideBetProxy],
            { client: { wallet: deployer } },
        );

        wiredRegistryAddress = registry.address;
        jackpotTreasuryAddress = jackpotTreasury.address;
        jackpotFunderAddress = funder.address;
    }

    const { addresses: linkedLibraryAddresses, engineLinks: libraryLinks } =
        await deployRouletteEngineLibraries(account);

    const vrfCoordinator = engineConstructorArgs[4] as Address;
    const vrfConfirmations = Number(engineConstructorArgs[7]);

    const nonceBeforeImpl = BigInt(
        await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    );
    const deployBrbReferral = options.deployBrbReferral ?? false;
    const implNonceOffset = deployBrbReferral ? 1n : 0n;
    const engineProxyForReferral = getContractAddress({
        from: account.address,
        nonce: nonceBeforeImpl + 1n + implNonceOffset,
    });

    let brbReferral = options.brbReferral ?? zeroAddress;
    if (deployBrbReferral) {
        const referralContract = await viem.deployContract("BRBReferal", [engineProxyForReferral], { client: { wallet: deployer } });
        brbReferral = referralContract.address;
    }

    const engineImplementation = await viem.deployContract(
        "RouletteEngine",
        [
            vrfCoordinator,
            vrfLaneKeyHashes[0],
            vrfLaneKeyHashes[1],
            vrfLaneKeyHashes[2],
            vrfConfirmations,
            brbReferral,
        ] as never,
        {
            client: { wallet: deployer },
            libraries: libraryLinks,
        },
    );

    // Use `pending` so the count includes txs already mined in this script (some Arbitrum RPCs lag on `latest`).
    const nonceBeforeProxy = BigInt(
        await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    );
    const engineProxyAddress = getContractAddress({ from: account.address, nonce: nonceBeforeProxy });
    const sideBetProxyAddress = getContractAddress({ from: account.address, nonce: nonceBeforeProxy + 2n });
    const upkeepSchedulerAddress = getContractAddress({ from: account.address, nonce: nonceBeforeProxy + 3n });

    const initData = encodeFunctionData({
        abi: engineImplementation.abi,
        functionName: "initialize",
        args: [
            {
                registry: wiredRegistryAddress,
                jackpotTreasury: jackpotTreasuryAddress,
                jackpotFunder: jackpotFunderAddress,
                infraRecipient: engineConstructorArgs[3] as Address,
                subscriptionId: engineConstructorArgs[5] as bigint,
                callbackGasLimit: engineConstructorArgs[6] as number,
                roundDuration: engineConstructorArgs[8] as number,
                admin: engineConstructorArgs[9] as Address,
                upkeepScheduler: upkeepSchedulerAddress,
            },
        ],
    });

    const proxy = await viem.deployContract("ERC1967Proxy", [engineImplementation.address, initData], { client: { wallet: deployer } });

    if (proxy.address.toLowerCase() !== engineProxyAddress.toLowerCase() ||
        (deployBrbReferral && proxy.address.toLowerCase() !== engineProxyForReferral.toLowerCase())) {
        throw new Error("Engine proxy CREATE address changed during deployment; stop and inspect the nonce journal");
    }
    const engine = await viem.getContractAt("RouletteEngine", proxy.address);

    const sideBetImplementation = await viem.deployContract("SideBet", [], { client: { wallet: deployer } });
    const sideBetInitData = encodeFunctionData({
        abi: sideBetImplementation.abi,
        functionName: "initialize",
        args: [
            scheduler.admin,
            engine.address,
            wiredRegistryAddress,
            sideBetMinMultiplierBps,
            sideBetMaxMultiplierBps,
        ],
    });
    const sideBetProxy = await viem.deployContract(
        "ERC1967Proxy",
        [sideBetImplementation.address, sideBetInitData],
        { client: { wallet: deployer } },
    );
    const sideBet = await viem.getContractAt("SideBet", sideBetProxy.address);

    if (sideBet.address.toLowerCase() !== sideBetProxyAddress.toLowerCase()) {
        const registry = await viem.getContractAt("MarketRegistry", wiredRegistryAddress);
        const expectedSideBet = await registry.read.SIDE_BET();
        if (sideBet.address.toLowerCase() !== expectedSideBet.toLowerCase()) {
            throw new Error(
                `SideBet proxy CREATE mismatch: expected ${sideBetProxyAddress} (registry ${expectedSideBet}) got ${sideBet.address}`,
            );
        }
    }

    const schedulerContract = await viem.deployContract(
        "UpkeepScheduler",
        [engine.address, sideBet.address, scheduler.admin, scheduler.scanLimit, scheduler.maxPayoutsPerCall],
        { client: { wallet: deployer } },
    );

    if (schedulerContract.address.toLowerCase() !== upkeepSchedulerAddress.toLowerCase()) {
        throw new Error(
            `UpkeepScheduler CREATE mismatch: expected ${upkeepSchedulerAddress} got ${schedulerContract.address}`,
        );
    }

    const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
    const settlementHash = await sideBet.write.grantRole([settlementRole, schedulerContract.address], { account });
    if ((await publicClient.waitForTransactionReceipt({ hash: settlementHash })).status !== "success") {
        throw new Error("Scheduler settlement-role grant reverted");
    }

    if (options.wireMockForwarder !== false) {
        const { wireTestSchedulerForwarder } = await import("../../test/helpers/wireTestSchedulerForwarder");
        await wireTestSchedulerForwarder(schedulerContract, account);
    }

    return {
        engine,
        engineImplementation,
        engineProxyInitData: initData as Hex,
        sideBet,
        sideBetImplementation,
        sideBetProxyInitData: sideBetInitData as Hex,
        scheduler: schedulerContract,
        brbReferral,
        registry: await viem.getContractAt("MarketRegistry", wiredRegistryAddress),
        jackpotTreasury: await viem.getContractAt("JackpotTreasury", jackpotTreasuryAddress),
        funder: await viem.getContractAt("BRBJackpotFunder", jackpotFunderAddress),
        linkedLibraries: linkedLibraryAddresses,
    };
}

/** Production entrypoint: predicts real prefix addresses before the first CREATE. */
export async function deployProductionRouletteEngine(params: {
    brb: Address; router: Address; admin: Address; infraRecipient: Address;
    coordinator: Address; subscriptionId: bigint; callbackGasLimit: number;
    confirmations: number; roundDuration: number;
    vrfKeyHashes: readonly [Hex, Hex, Hex]; scheduler: UpkeepSchedulerDeployConfig;
}) {
    const [wallet] = await viem.getWalletClients();
    const client = await viem.getPublicClient();
    if (wallet.account.address.toLowerCase() !== params.admin.toLowerCase()) throw new Error("Production bootstrap admin must be the deployment signer");
    const nonce = BigInt(await client.getTransactionCount({ address: wallet.account.address, blockTag: "pending" }));
    const treasury = getContractAddress({ from: wallet.account.address, nonce });
    const funder = getContractAddress({ from: wallet.account.address, nonce: nonce + 1n });
    const registry = getContractAddress({ from: wallet.account.address, nonce: nonce + 2n });
    const stack = await deployRouletteEngine(params.vrfKeyHashes, [
        registry, treasury, funder, params.infraRecipient, params.coordinator,
        params.subscriptionId, params.callbackGasLimit, params.confirmations,
        params.roundDuration, params.admin,
    ], params.scheduler, {
        protocolPrefix: { brb: params.brb, router: params.router, admin: params.admin },
        deployBrbReferral: true, wireMockForwarder: false,
    });
    for (const [name, actual, expected] of [
        ["registry", stack.registry.address, registry],
        ["treasury", stack.jackpotTreasury.address, treasury],
        ["funder", stack.funder.address, funder],
    ]) {
        if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${name} CREATE prediction mismatch`);
    }
    return stack;
}
