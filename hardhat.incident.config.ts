import base from "./hardhat.config";
import type { HardhatUserConfig } from "hardhat/config";
const config: HardhatUserConfig = {
    ...base, defaultNetwork: "hardhat",
    networks: { hardhat: { chainId: 31337, allowUnlimitedContractSize: false,
        accounts: { mnemonic: "test test test test test test test test test test test junk",
            count: process.env.INCIDENT_20261104_FORK_CHILD === "1" ? 1 : 128,
            accountsBalance: "10000000000000000000000" } } },
    gasReporter: { ...base.gasReporter, enabled: false },
};
export default config;
