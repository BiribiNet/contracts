import hre, { ethers, network } from 'hardhat';

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { config } from 'dotenv';
import { WebSocketProvider, type JsonRpcSigner } from 'ethers';

import { deployContracts, type DeployConfig } from './utils/deployUtils';

config();

async function main() {
  const useTenderly = hre.network.name === 'tenderly';
  
  // Default to upgrade only mode
  const upgradeOnly = true;
  console.info('Upgrading existing deployment to V2');
  
  // Required env vars for upgrade
  const requiredEnvVars = [
    'CREATE2_ADDRESS',
    'SALT_IMPL_V2',
    'CURRENCY',
    'PROXY_ADDRESS',
    'CREATE2_ADMIN'
  ] as const;
  
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Environment variable ${envVar} is required`);
    }
  }

  if (useTenderly && !process.env.CREATE2_ADMIN) {
    throw new Error('CREATE2_ADMIN is required when not using Tenderly');
  }
  
  const deployConfig: DeployConfig = {
    CREATE2_ADDRESS: process.env.CREATE2_ADDRESS!,
    CREATE2_ADMIN: useTenderly ? process.env.CREATE2_ADMIN : undefined,
    CURRENCY: process.env.CURRENCY!,
    SALT_IMPL: '', // Not needed for upgrade
    SALT_IMPL_V2: `${process.env.SALT_IMPL_V2!}${process.env.CURRENCY!}`,
    SALT_PROXY: '', // Not needed for upgrade
    upgradeOnly,
    proxyAddress: process.env.PROXY_ADDRESS!
  };

  // Only create Frame provider if not using Tenderly
    const provider = new WebSocketProvider(
      'ws://127.0.0.1:1248',
      {
        chainId: hre.network.config.chainId ?? 5,
        name: hre.network.name,
      },
    );

   const signer = await provider.getSigner();
    await provider.send('wallet_switchEthereumChain', [
      { chainId: `0x${(hre.network.config.chainId ?? 1).toString(16)}` },
    ]);
  
  const { implV2Address } = await deployContracts(signer, deployConfig, { useTenderly });
  console.log('Successfully upgraded to V2 implementation at:', implV2Address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Export for use by other scripts
export { main as deployV1ToV2 }; 