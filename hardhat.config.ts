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
import 'solidity-coverage';

import networks from './hardhat.network';

const defaultSettings: SolcUserConfig['settings'] = {
  viaIR: false,
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
  mocha: {
    timeout: process.env.SOLIDITY_COVERAGE === 'true' ? 1_200_000 : 40_000,
    require: ['./test/coverageHooks.ts'],
  },
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
    enabled:
      process.env.SOLIDITY_COVERAGE === 'true'
        ? false
        : vars.has('REPORT_GAS') || vars.has('ETHERSCAN_API_KEY'),
    coinmarketcap: vars.has('REPORT_GAS') ? vars.get('REPORT_GAS') : '',
    currency: 'EUR',
  },
  etherscan: {
    // Single Etherscan.io API key → Hardhat verify uses API v2 with `chainid` from `customChains` / network.
    apiKey: vars.has('ETHERSCAN_API_KEY') ? vars.get('ETHERSCAN_API_KEY') : '',
    customChains: [
      {
        network: 'arbitrumsepolia',
        chainId: 421614,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=421614',
          browserURL: 'https://sepolia.arbiscan.io',
        },
      },
    ],
  },
};
export default config;
