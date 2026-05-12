import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from '@wagmi/cli/config';
import { hardhat } from '@wagmi/cli/plugins';
import type { Abi } from 'viem';

const automationRegistryAbi = JSON.parse(
  readFileSync(
    join(process.cwd(), 'node_modules/@chainlink/contracts/abi/v0.8/AutomationRegistryBaseInterface.json'),
    'utf8',
  ),
) as Abi;

/** Typed ABIs for the frontend (viem / wagmi). Run after `hardhat compile`. */
export default defineConfig({
  out: '../frontend/lib/abi/generated.ts',
  contracts: [
    {
      name: 'AutomationRegistry',
      abi: automationRegistryAbi,
    },
  ],
  plugins: [
    hardhat({
      project: '.',
      commands: {
        // `compile` already ran `hardhat compile`; avoid compiling twice.
        build: false,
        clean: false,
      },
      include: [
        'MockUSDC.sol/MockUSDC.json',
        'BankVault4626.sol/BankVault4626.json',
        'BRBToken.sol/BRBToken.json',
        'BRBJackpotFunder.sol/BRBJackpotFunder.json',
        'LPVestingLock.sol/LPVestingLock.json',
        'JackpotTreasury.sol/JackpotTreasury.json',
        'MarketRegistry.sol/MarketRegistry.json',
        'RouletteEngine.sol/RouletteEngine.json',
        'UpkeepScheduler.sol/UpkeepScheduler.json',
        'UpkeepManager.sol/UpkeepManager.json',
        '@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol/VRFCoordinatorV2_5Mock.json',
      ],
    }),
  ],
});
