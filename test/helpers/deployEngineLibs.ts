import { viem } from "hardhat";

import { deployRouletteEngineLibraries } from "../../scripts/utils/deployRouletteEngineLibraries";

/** Linked-library map for a `RouletteEngine` / harness implementation deploy. */
export async function deployEngineLibs() {
    const [deployer] = await viem.getWalletClients();
    const { engineLinks } = await deployRouletteEngineLibraries(deployer.account);
    return engineLinks;
}
