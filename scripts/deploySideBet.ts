import { viem } from "hardhat";
import { encodeFunctionData, type Address } from "viem";

export type SideBetDeployConfig = {
    admin: Address;
    /** Lower bound of the payout multiplier band, in bps (e.g. 50_000 = 5x). Must be > 10_000. */
    minMultiplierBps: number;
    /** Upper bound of the payout multiplier band, in bps (e.g. 200_000 = 20x). */
    maxMultiplierBps: number;
    /** Resolver incentive as a share of the stake, in bps (e.g. 10 = 0.1%). */
    resolverFeeBps: number;
    /** Optional keeper granted SPIN_FEEDER_ROLE (relays RouletteEngine.VRFResult). */
    spinFeeder?: Address;
};

/**
 * Deploy the `SideBet` implementation behind an `ERC1967Proxy` (UUPS), initialised with the
 * multiplier band + resolver fee. Mirrors the proxy pattern in `deployRouletteEngine`.
 */
export async function deploySideBet(config: SideBetDeployConfig) {
    const [deployer] = await viem.getWalletClients();
    const account = deployer.account;

    const implementation = await viem.deployContract("SideBet", [], { account });

    const initData = encodeFunctionData({
        abi: implementation.abi,
        functionName: "initialize",
        args: [config.admin, config.minMultiplierBps, config.maxMultiplierBps, config.resolverFeeBps],
    });

    const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData], { account });
    const sideBet = await viem.getContractAt("SideBet", proxy.address);

    if (config.spinFeeder) {
        const spinFeederRole = await sideBet.read.SPIN_FEEDER_ROLE();
        await sideBet.write.grantRole([spinFeederRole, config.spinFeeder], { account });
    }

    return { sideBet, implementation };
}

async function main(): Promise<void> {
    const [deployer] = await viem.getWalletClients();
    const { sideBet, implementation } = await deploySideBet({
        admin: deployer.account.address,
        minMultiplierBps: 50_000, // 5x
        maxMultiplierBps: 200_000, // 20x
        resolverFeeBps: 10, // 0.1%
    });

    // eslint-disable-next-line no-console
    console.log("SideBet implementation:", implementation.address);
    // eslint-disable-next-line no-console
    console.log("SideBet proxy:", sideBet.address);
}

// Allow `hardhat run scripts/deploySideBet.ts` while keeping `deploySideBet` importable from tests.
if (require.main === module) {
    main().catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
    });
}
