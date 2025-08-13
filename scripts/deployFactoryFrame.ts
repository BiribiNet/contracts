import hre from 'hardhat';

import { config } from 'dotenv';
import { WebSocketProvider } from 'ethers';

import { deployContracts, type DeployConfig } from './utils/deployUtils';

config();

async function main() {
  console.info('Deploying FactoryFrame');
  // Vérification des variables d'environnement requises
  const requiredEnvVars = ['CREATE2_ADDRESS', 'SALT_IMPL', 'SALT_IMPL_V2', 'SALT_PROXY', 'CURRENCY', 'PROXY_ADDRESS'] as const;
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`La variable d'environnement ${envVar} est requise`);
    }
  }
  console.info("Variables d'environnement vérifiées");
  const config: DeployConfig = {
    proxyAddress: process.env.PROXY_ADDRESS!,
    CREATE2_ADMIN: process.env.CREATE2_ADMIN ?? "",
    SALT_IMPL_V2: process.env.SALT_IMPL_V2!,
    CREATE2_ADDRESS: process.env.CREATE2_ADDRESS!,
    CURRENCY: process.env.CURRENCY!,
    SALT_IMPL: `${process.env.SALT_IMPL! ?? 'RE'}${process.env.CURRENCY!}`,
    SALT_PROXY: `${process.env.SALT_PROXY! ?? 'RE'}${process.env.CURRENCY!}`,
    upgradeOnly: false
  };

  console.info('Configuration des variables');
  // Get signer from Frame
  const provider = new WebSocketProvider(
    'ws://127.0.0.1:1248', // RPC FRAME
    {
      chainId: hre.network.config.chainId ?? 5,
      name: hre.network.name,
    },
  );

  console.info('Getting signer');
  console.info('Switching to the correct chain');
  await provider.send('wallet_switchEthereumChain', [
    { chainId: `0x${(hre.network.config.chainId ?? 1).toString(16)}` },
  ]);
  console.info('Deploying contracts');
  const useTenderly = hre.network.name === 'tenderly';

  const signer = await provider.getSigner();
  await deployContracts(signer, config, { useTenderly });
  console.info('Contracts deployed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
