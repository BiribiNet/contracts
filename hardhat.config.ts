import { writeFile } from 'fs/promises';
import { join } from 'path';

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
  optimizer: { enabled: true }
};

type ContractMap = Record<string, { abi: object }>;

subtask(TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS).setAction(
  async (args, env, next) => {
    const output = await next();
    const { artifacts } = env.config.paths;
    const promises = Object.entries(args.output.contracts).map(
      async ([sourceName, contract]) => {
        const file = join(artifacts, sourceName, 'abi.ts');
        const { abi } = Object.values(contract as ContractMap)[0];
        const data = `export const abi = ${JSON.stringify(abi, null, 2)} as const;`;
        await writeFile(file, data);
      },
    );
    await Promise.all(promises);
    return output;
  },
);

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: '0.8.27', settings: defaultSettings }],
  },
  networks,
  // comment this below to verify on Tenderly
  gasReporter: {
    L2: "arbitrum",
    etherscan: vars.get('ETHERSCAN_API_KEY'),
    enabled: vars.has('REPORT_GAS') || vars.has('ETHERSCAN_API_KEY'),
    coinmarketcap: vars.get('REPORT_GAS'),
    currency: 'EUR',
  },
  etherscan: {
    apiKey: vars.get('ETHERSCAN_API_KEY'),
    customChains: [
      {
        network: "arbitrumsepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=421614&apikey=" + vars.get('ETHERSCAN_API_KEY'),
          browserURL: "https://sepolia.arbiscan.io"
        }
      },
    ]
  },
};
export default config;
