import { vars, type HardhatUserConfig } from 'hardhat/config';
import type { SolcUserConfig } from 'hardhat/types';

import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-toolbox-viem';
import '@nomicfoundation/hardhat-chai-matchers';
import 'tsconfig-paths/register';
import '@openzeppelin/hardhat-upgrades';

import networks from './hardhat.network';

const defaultSettings: SolcUserConfig['settings'] = {
  optimizer: { enabled: true },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: '0.8.27', settings: defaultSettings }],
  },
  networks,
  gasReporter: {
    offline: true,
    enabled: vars.has('REPORT_GAS'),
    coinmarketcap: vars.get('REPORT_GAS'),
    gasPrice: 20,
    currency: 'USD',
  },
  etherscan: {
    apiKey: {
      xdai: vars.get('GNOSIS_SCAN_API_KEY'),
      sepolia: vars.get('ETHERSCAN_API_KEY'),
      mainnet: vars.get('ETHERSCAN_API_KEY'),
    },
  },
};
export default config;
