import { viem } from "hardhat";
import { encodeFunctionData, isAddress, type Address } from "viem";

/** High-odds (>100x) demo templates seeded for a given staked token. */
export function highOddsSeedTemplates(token: Address) {
    const minStake = 1_000_000n; // 1.0 at 6 decimals (USDC-style); admin can retune per token
    const maxStake = 1_000_000_000n; // 1,000.0 at 6 decimals
    return [
        // Lightning Double: any number twice in a row within 6 spins (~150x).
        { token, betType: 4, color: 0, targetNumber: 37, targetCount: 2, redRatioBps: 0, windowSpins: 6, multiplierBps: 1_500_000, minStake, maxStake, enabled: true },
        // Zebra: colors alternate perfectly for 8 spins (~150x).
        { token, betType: 5, color: 0, targetNumber: 0, targetCount: 0, redRatioBps: 0, windowSpins: 8, multiplierBps: 1_500_000, minStake, maxStake, enabled: true },
        // Dozen Sweep: the 1st dozen hits on all 5 spins (~250x).
        { token, betType: 6, color: 0, targetNumber: 1, targetCount: 5, redRatioBps: 0, windowSpins: 5, multiplierBps: 2_500_000, minStake, maxStake, enabled: true },
    ] as const;
}

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
        maxMultiplierBps: 5_000_000, // 500x — headroom for the >100x bet types
        resolverFeeBps: 10, // 0.1%
    });

    // eslint-disable-next-line no-console
    console.log("SideBet implementation:", implementation.address);
    // eslint-disable-next-line no-console
    console.log("SideBet proxy:", sideBet.address);

    // Optionally seed high-odds demo templates against a configured token.
    const seedToken = process.env.SIDE_BET_SEED_TOKEN;
    if (seedToken && isAddress(seedToken)) {
        for (const template of highOddsSeedTemplates(seedToken)) {
            await sideBet.write.addConfig([template], { account: deployer.account });
        }
        // eslint-disable-next-line no-console
        console.log("Seeded high-odds templates for token:", seedToken);
    } else {
        // eslint-disable-next-line no-console
        console.log("Set SIDE_BET_SEED_TOKEN to a token address to seed demo templates.");
    }
}

// Allow `hardhat run scripts/deploySideBet.ts` while keeping `deploySideBet` importable from tests.
if (require.main === module) {
    main().catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
    });
}
