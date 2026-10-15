import config from "./hardhat.config";

// Deterministic local audit: no gas-price API calls; enforce production size limits.
export default {
    ...config,
    gasReporter: { ...config.gasReporter, enabled: false },
    networks: { ...config.networks, hardhat: { ...config.networks?.hardhat, allowUnlimitedContractSize: false } },
};
