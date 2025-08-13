import hre, { ethers } from 'hardhat';

import { config } from 'dotenv';

import { deployContracts, type DeployConfig } from './utils/deployUtils';

config();

async function main() {
  // Vérification des variables d'environnement requises
  const requiredEnvVars = ['CREATE2_ADDRESS', 'SALT_IMPL', 'SALT_PROXY', 'CURRENCY', 'PROXY_ADDRESS'] as const;
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`La variable d'environnement ${envVar} est requise`);
    }
  }

  const config: DeployConfig = {
    SALT_IMPL_V2: process.env.SALT_IMPL_V2 ?? "",
    CREATE2_ADDRESS: process.env.CREATE2_ADDRESS!,
    CREATE2_ADMIN: process.env.CREATE2_ADMIN ?? "",
    CURRENCY: process.env.CURRENCY!,
    SALT_IMPL: `${process.env.SALT_IMPL! ?? 'RE'}${process.env.CURRENCY!}`,
    SALT_PROXY: `${process.env.SALT_PROXY! ?? 'RE'}${process.env.CURRENCY!}`,
    proxyAddress: process.env.PROXY_ADDRESS!,
    upgradeOnly: false
  };

  const useTenderly = hre.network.name === 'tenderly';

  const [signer] = await ethers.getSigners();
  await deployContracts(signer, config, { useTenderly });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
