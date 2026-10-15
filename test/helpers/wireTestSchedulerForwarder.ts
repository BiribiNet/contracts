import { viem } from "hardhat";

import type { Account, Address } from "viem";

type SchedulerForwarderTarget = {
    write: {
        setForwarderAuthority: (args: [Address], opts: { account: Account }) => Promise<unknown>;
    };
};

/** Wires a permissive mock `forwarderAuthority` so tests can call `performUpkeep` directly. */
export async function wireTestSchedulerForwarder(scheduler: SchedulerForwarderTarget, admin: Account) {
    const mockAuth = await viem.deployContract("MockUpkeepForwarderAuthority");
    await mockAuth.write.setApproveAll([true]);
    await scheduler.write.setForwarderAuthority([mockAuth.address], { account: admin });
    return mockAuth;
}
