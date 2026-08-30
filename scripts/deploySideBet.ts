import { viem } from "hardhat";

import { encodeFunctionData, isAddress, type Address } from "viem";

export type SideBetDeployConfig = {
    admin: Address;
    engine: Address;
    registry: Address;
    minMultiplierBps: number;
    maxMultiplierBps: number;
    /** Chainlink Automation scheduler (`UpkeepScheduler`); granted `SETTLEMENT_ROLE` on SideBet. */
    upkeepScheduler?: Address;
};

export async function deploySideBet(config: SideBetDeployConfig) {
    const [deployer] = await viem.getWalletClients();
    const account = deployer.account;

    const implementation = await viem.deployContract("SideBet", [], { account });

    const initData = encodeFunctionData({
        abi: implementation.abi,
        functionName: "initialize",
        args: [config.admin, config.engine, config.registry, config.minMultiplierBps, config.maxMultiplierBps],
    });

    const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData], { account });
    const sideBet = await viem.getContractAt("SideBet", proxy.address);

    if (config.upkeepScheduler) {
        const settlementRole = await sideBet.read.SETTLEMENT_ROLE();
        await sideBet.write.grantRole([settlementRole, config.upkeepScheduler], { account });
    }

    return { sideBet, implementation };
}

async function main(): Promise<void> {
    const [deployer] = await viem.getWalletClients();
    const registry = process.env.SIDE_BET_REGISTRY;
    const engine = process.env.SIDE_BET_ENGINE;
    if (!registry || !isAddress(registry) || !engine || !isAddress(engine)) {
        throw new Error("Set SIDE_BET_REGISTRY and SIDE_BET_ENGINE to deployed protocol addresses.");
    }

    const { sideBet, implementation } = await deploySideBet({
        admin: deployer.account.address,
        registry,
        engine,
        minMultiplierBps: 50_000,
        maxMultiplierBps: 5_000_000,
    });


    console.log("SideBet implementation:", implementation.address);

    console.log("SideBet proxy:", sideBet.address);

    console.log(
        "Next: seed the bet catalogue with `yarn seed:side-bets:arbitrum-sepolia` — a SideBet with " +
            "no config offers nothing and every placeBet reverts UnknownConfig.",
    );
}

if (require.main === module) {
    main().catch((error) => {
         
        console.error(error);
        process.exitCode = 1;
    });
}
