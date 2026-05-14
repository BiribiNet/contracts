import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS } from 'hardhat/builtin-tasks/task-names';
import { subtask, vars, type HardhatUserConfig } from 'hardhat/config';
import type { SolcUserConfig } from 'hardhat/types';
import 'hardhat-tracer'

// Uncomment this to verify on Tenderly
// import * as tdly from "@tenderly/hardhat-tenderly";
// tdly.setup()

// Comment this to verify on Tenderly
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-toolbox-viem';
import '@nomicfoundation/hardhat-chai-matchers';
import 'tsconfig-paths/register';
import '@openzeppelin/hardhat-upgrades';

import networks from './hardhat.network';

const defaultSettings: SolcUserConfig['settings'] = {
  viaIR: true,
  optimizer: { enabled: true, runs: 1 },
  metadata: { bytecodeHash: 'none' },
  evmVersion: 'cancun',
};

type ContractMap = Record<string, { abi: object }>;

subtask(TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS).setAction(
  async (args, env, next) => {
    const output = await next();
    const { artifacts } = env.config.paths;
    const promises = Object.entries(args.output.contracts).map(
      async ([sourceName, contract]) => {
        const compiled = Object.values(contract as ContractMap)[0];
        if (!compiled?.abi) return;
        const file = join(artifacts, sourceName, 'abi.ts');
        const data = `export const abi = ${JSON.stringify(compiled.abi, null, 2)} as const;`;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, data);
      },
    );
    await Promise.all(promises);
    return output;
  },
);

const uniswapOptimizer = { enabled: true as const, runs: 999999 };
const uniswap05Settings = {
  optimizer: uniswapOptimizer,
  evmVersion: 'istanbul' as const,
};
const uniswap06Settings = {
  optimizer: uniswapOptimizer,
  evmVersion: 'istanbul' as const,
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      { version: '0.8.27', settings: defaultSettings },
      { version: '0.5.16', settings: uniswap05Settings },
      { version: '0.6.6', settings: uniswap06Settings },
    ],
  },
  networks,
  // comment this below to verify on Tenderly
  gasReporter: {
    L2: "arbitrum",
    etherscan: vars.has('ETHERSCAN_API_KEY') ? vars.get('ETHERSCAN_API_KEY') : '',
    enabled: vars.has('REPORT_GAS') || vars.has('ETHERSCAN_API_KEY'),
    coinmarketcap: vars.has('REPORT_GAS') ? vars.get('REPORT_GAS') : '',
    currency: 'EUR',
  },
  etherscan: {
    // Single string key → Hardhat uses Etherscan API v2 for all supported chains (incl. Arbitrum Sepolia).
    apiKey: vars.has('ETHERSCAN_API_KEY') ? vars.get('ETHERSCAN_API_KEY') : '',
    customChains: [
      {
        network: 'arbitrumsepolia',
        chainId: 421614,
        urls: {
          // Ignored when using a string apiKey (v2); kept for tooling that reads customChains.urls.apiURL.
          apiURL: 'https://api.etherscan.io/v2/api',
          browserURL: 'https://sepolia.arbiscan.io',
        },
      },
    ],
  },
};
export default config;
