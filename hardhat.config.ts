import { writeFile } from 'fs/promises';
import { join } from 'path';

import { TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS } from 'hardhat/builtin-tasks/task-names';
import { subtask, vars, type HardhatUserConfig } from 'hardhat/config';
import type { SolcUserConfig } from 'hardhat/types';
import 'hardhat-tracer'

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
  gasReporter: {
    L2: "arbitrum",
    etherscan: vars.get('ETHERSCAN_API_KEY'),
    enabled: vars.has('REPORT_GAS') || vars.has('ETHERSCAN_API_KEY'),
    coinmarketcap: vars.get('REPORT_GAS'),
    currency: 'EUR',
  },
  etherscan: {
    apiKey: {
      xdai: vars.get('GNOSIS_SCAN_API_KEY'),
      sepolia: vars.get('ETHERSCAN_API_KEY'),
      mainnet: vars.get('ETHERSCAN_API_KEY'),
      arbitrumSepolia: vars.get('ETHERSCAN_API_KEY'),
    },
  },
};
export default config;
