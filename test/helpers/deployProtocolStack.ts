import { viem } from "hardhat";

import { zeroAddress, type Address } from "viem";

import { deployRouletteEngine, type UpkeepSchedulerDeployConfig } from "../../scripts/utils/deployRouletteEngine";

export type DeployProtocolStackOptions = {
    scanLimit?: number;
    maxPayoutsPerCall?: number;
    deployBrbReferral?: boolean;
    infraRecipient?: Address;
    roundDuration?: number;
};

/**
 * Standard protocol stack: BRB + VRF + router → `deployRouletteEngine` with `protocolPrefix`.
 */
export async function deployProtocolStack(options: DeployProtocolStackOptions = {}) {
    const [deployer] = await viem.getWalletClients();
    const admin = deployer.account.address;
    const infraRecipient = options.infraRecipient ?? admin;
    const roundDuration = options.roundDuration ?? 500;

    const brb = await viem.deployContract("BRBToken", [admin], { account: deployer.account });
    const vrf = await viem.deployContract("MockVrfCoordinator", [], { account: deployer.account });
    const router = await viem.deployContract("MockUniswapV2Router", [], { account: deployer.account });

    const mockLaneKey = ("0x" + "11".repeat(32)) as `0x${string}`;
    const scheduler: UpkeepSchedulerDeployConfig = {
        admin,
        scanLimit: options.scanLimit ?? 25,
        maxPayoutsPerCall: options.maxPayoutsPerCall ?? 10,
    };

    const stack = await deployRouletteEngine(
        [mockLaneKey, mockLaneKey, mockLaneKey],
        [
            zeroAddress,
            zeroAddress,
            zeroAddress,
            infraRecipient,
            vrf.address,
            1n,
            2_000_000,
            1,
            roundDuration,
            admin,
        ],
        scheduler,
        {
            deployBrbReferral: options.deployBrbReferral,
            protocolPrefix: {
                brb: brb.address,
                mockRouter: router.address,
                admin,
            },
        },
    );

    return {
        admin,
        deployer,
        brb,
        vrf,
        router,
        treasury: stack.jackpotTreasury!,
        funder: stack.funder!,
        registry: stack.registry!,
        ...stack,
    };
}
