import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox-viem";
import "tsconfig-paths/register";
import type { HardhatUserConfig } from "hardhat/config";

// Deliberately standalone: never import hardhat.network.ts or any private-key settings.
const settings = {
    viaIR: false,
    optimizer: { enabled: true, runs: 1 },
    metadata: { bytecodeHash: "none" as const },
    evmVersion: "cancun",
};
const config: HardhatUserConfig = {
    defaultNetwork: "hardhat",
    networks: {
        hardhat: {
            chainId: 31337,
            allowUnlimitedContractSize: false,
            accounts: {
                mnemonic: "test test test test test test test test test test test junk",
                count: 4,
            },
        },
    },
    solidity: {
        compilers: [
            { version: "0.8.27", settings },
            { version: "0.5.16", settings: { optimizer: { enabled: true, runs: 999999 }, evmVersion: "istanbul" } },
            { version: "0.6.6", settings: { optimizer: { enabled: true, runs: 999999 }, evmVersion: "istanbul" } },
        ],
        overrides: { "contracts/SideBet.sol": { version: "0.8.27", settings: { ...settings, viaIR: true } } },
    },
};
export default config;
