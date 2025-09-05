import { vars } from 'hardhat/config';
import type { NetworksUserConfig } from 'hardhat/types';

const networks: NetworksUserConfig = {};

networks.hardhat = {};

networks.localhost = {
  url: 'http://localhost:8545',
  chainId: 31337,
  accounts: [vars.get('PRIVATE_KEY')],
};

if (vars.has('PRIVATE_KEY')) {
  if (vars.has('MAINNET_RPC_URL')) {
    networks.mainnet = {
      url: vars.get('MAINNET_RPC_URL'),
      chainId: 1,
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('HOLESKY_RPC_URL')) {
    networks.holesky = {
      url: vars.get('HOLESKY_RPC_URL'),
      chainId: 17000,
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('SEPOLIA_RPC_URL')) {
    networks.sepolia = {
      url: vars.get('SEPOLIA_RPC_URL'),
      chainId: 11155111,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('GOERLI_RPC_URL')) {
    networks.goerli = {
      url: vars.get('GOERLI_RPC_URL'),
      chainId: 5,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('GNOSIS_RPC_URL')) {
    networks.gnosis = {
      url: vars.get('GNOSIS_RPC_URL'),
      chainId: 100,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('SOKOL_RPC_URL')) {
    networks.sokol = {
      url: vars.get('SOKOL_RPC_URL'),
      chainId: 77,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('BSC_RPC_URL')) {
    networks.bsc = {
      url: vars.get('BSC_RPC_URL'),
      chainId: 56,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('BSCTEST_RPC_URL')) {
    networks.bsctest = {
      url: vars.get('BSCTEST_RPC_URL'),
      chainId: 97,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('MATIC_RPC_URL')) {
    networks.matic = {
      url: vars.get('MATIC_RPC_URL'),
      chainId: 137,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('MUMBAI_RPC_URL')) {
    networks.mumbai = {
      url: vars.get('MUMBAI_RPC_URL'),
      chainId: 80001,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('ARBITRUM_RPC_URL')) {
    networks.arbitrum = {
      url: vars.get('ARBITRUM_RPC_URL'),
      chainId: 42161,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('ARBITRUM_SEPOLIA_RPC_URL')) {
    networks.arbitrumsepolia = {
      url: vars.get('ARBITRUM_SEPOLIA_RPC_URL'),
      chainId: 421614,
      gasPrice: 'auto',
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }

  if (vars.has('TENDERLY_RPC_URL')) {
    networks.tenderly = {
      url: vars.get('TENDERLY_RPC_URL'),
      chainId: 1,
      accounts: [vars.get('PRIVATE_KEY')],
    };
  }
}

export default networks;
