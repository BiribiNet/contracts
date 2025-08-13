import hre, { ethers } from 'hardhat';
import type { HttpNetworkUserConfig } from 'hardhat/types';

import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { AbiCoder, hashMessage, type Signer } from 'ethers';

import { waitForTransaction } from './waitForTransaction';

const config = hre.network.config as HttpNetworkUserConfig;

if (hre.network.name === 'tenderly') {
  config.accounts = 'remote';
}

// ICreate2 ABI for the deployment
const create2Abi = [
  {
    inputs: [
      { name: 'value', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
      { name: 'code', type: 'bytes' },
      { name: 'data', type: 'bytes' },
    ],
    name: 'deploy',
    outputs: [{ name: '', type: 'address' }],
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'newContract',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'salt',
        type: 'bytes32',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'bytecodeHash',
        type: 'bytes32',
      },
    ],
    name: 'Deployed',
    type: 'event',
  },
] as const;
export default create2Abi;

export interface DeployConfig {
  CREATE2_ADDRESS: string;
  CREATE2_ADMIN?: string;
  SALT_IMPL: string;
  SALT_IMPL_V2: string;
  SALT_PROXY: string;
  CURRENCY: string;
  upgradeOnly?: boolean;
  proxyAddress: string; // Required when upgradeOnly is true
}

export async function deployContracts(
  signer: Signer | HardhatEthersSigner,
  config: DeployConfig,
  options: {
    useTenderly?: boolean;
  } = {},
) {
  const { CREATE2_ADDRESS, CREATE2_ADMIN, SALT_IMPL, SALT_IMPL_V2, SALT_PROXY, CURRENCY, upgradeOnly, proxyAddress } =
    config;

  if (options.useTenderly && config.CREATE2_ADMIN) {
    signer = await ethers.getSigner(config.CREATE2_ADMIN);
  }

  const signerAddress = await signer.getAddress();
  console.log('Deploying with account:', signerAddress);

  if (!signer.provider) throw new Error('signer provider is undefined!! nothing has been done!');

  if (upgradeOnly && !proxyAddress) {
    throw new Error('proxyAddress is required when upgradeOnly is true');
  }

  const create2Contract = new ethers.Contract(CREATE2_ADDRESS, create2Abi, signer);

  if (!upgradeOnly) {
    // Deploy V1 first
    console.log('Deploying V1 implementation...');
    const ReusdV1Factory = await ethers.getContractFactory('contracts/Reusd.sol:REUSD');
    const implV1Bytecode = ReusdV1Factory.bytecode;

    const tx = await signer.sendTransaction({
      data: create2Contract.interface.encodeFunctionData('deploy', [0, hashMessage(SALT_IMPL), implV1Bytecode, '0x']),
      ...(options.useTenderly && CREATE2_ADMIN ? { from: CREATE2_ADMIN } : {}),
      to: CREATE2_ADDRESS,
    });
    const receipt = await waitForTransaction(signer.provider, tx);

    if (!receipt?.logs?.length) throw new Error('No logs in receipt');

    const getDeployedLog = receipt.logs.find(
      (val) => val.topics[0] === '0x9f9c566772ebd31147263ece7c6da0220df641c474d0fb11b7691471022ca1f9',
    );
    if (!getDeployedLog) throw new Error('Deployed event not found');

    const deployedEvent = create2Contract.interface.parseLog(getDeployedLog);
    if (!deployedEvent) throw new Error('Could not parse deployed event');

    const implV1Address = deployedEvent.args[0];
    console.log('V1 Implementation deployed at:', implV1Address);

    // Deploy proxy pointing to V1
    console.log('Deploying proxy...');
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const proxyBytecode = ERC1967Proxy.bytecode;

    const factory = new ethers.Contract(implV1Address, ReusdV1Factory.interface, signer);
    const initializeData = factory.interface.encodeFunctionData('initialize', [
      options.useTenderly && CREATE2_ADMIN ? CREATE2_ADMIN : signerAddress,
      CURRENCY,
    ]);

    const proxyTx = await signer.sendTransaction({
      data: create2Contract.interface.encodeFunctionData('deploy', [
        0,
        hashMessage(SALT_PROXY),
        proxyBytecode + AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [implV1Address, '0x']).slice(2),
        initializeData,
      ]),
      ...(options.useTenderly && CREATE2_ADMIN ? { from: CREATE2_ADMIN } : {}),
      to: CREATE2_ADDRESS,
    });

    const proxyReceipt = await waitForTransaction(signer.provider, proxyTx);
    if (!proxyReceipt?.logs?.length) throw new Error('No logs in proxy receipt');

    const proxyDeployedLog = proxyReceipt.logs.find(
      (val) => val.topics[0] === '0x9f9c566772ebd31147263ece7c6da0220df641c474d0fb11b7691471022ca1f9',
    );
    if (!proxyDeployedLog) throw new Error('Proxy deployed event not found');

    const proxyDeployedEvent = create2Contract.interface.parseLog(proxyDeployedLog);
    if (!proxyDeployedEvent) throw new Error('Could not parse proxy deployed event');

    const proxyAddress = proxyDeployedEvent.args[0];
    console.log('Proxy deployed at:', proxyAddress);
  }

  // Deploy V2 implementation
  console.log('Deploying V2 implementation...');
  // Get implementation V2 bytecode and ABI
  const ReusdV2Factory = await ethers.getContractFactory('contracts/Reusdv2.sol:REUSD');
  const implV2Bytecode = ReusdV2Factory.bytecode;

  const implV2Tx = await signer.sendTransaction({
    data: create2Contract.interface.encodeFunctionData('deploy', [0, hashMessage(SALT_IMPL_V2), implV2Bytecode, '0x']),
    ...(options.useTenderly && CREATE2_ADMIN ? { from: CREATE2_ADMIN } : {}),
    to: CREATE2_ADDRESS,
  });

  const implV2Receipt = await waitForTransaction(signer.provider, implV2Tx);
  if (!implV2Receipt?.logs?.length) throw new Error('No logs in V2 receipt');

  const implV2DeployedLog = implV2Receipt.logs.find(
    (val) => val.topics[0] === '0x9f9c566772ebd31147263ece7c6da0220df641c474d0fb11b7691471022ca1f9',
  );
  if (!implV2DeployedLog) throw new Error('V2 deployed event not found');

  const implV2DeployedEvent = create2Contract.interface.parseLog(implV2DeployedLog);
  if (!implV2DeployedEvent) throw new Error('Could not parse V2 deployed event');

  const implV2Address = implV2DeployedEvent.args[0];
  console.log('V2 Implementation deployed at:', implV2Address);

  console.log('Upgrading proxy to V2 implementation...');
  // Create contract instance of the proxy with V1 ABI (which has the upgrade function)
  const proxyContract = new ethers.Contract(
    proxyAddress,
    ['function upgradeToAndCall(address,bytes) external payable'],
    signer,
  );

  // Initialize data for V2 (empty in this case as we don't need to call any function)
  const initializeData = ReusdV2Factory.interface.encodeFunctionData('initialize', [CURRENCY]);

  // Call upgradeToAndCall
  const upgradeTx = await proxyContract.upgradeToAndCall(implV2Address, initializeData);

  const upgradeReceipt = await waitForTransaction(signer.provider, upgradeTx);
  if (!upgradeReceipt.status) {
    throw new Error('Upgrade transaction failed');
  }

  console.log('Successfully upgraded proxy to V2 implementation');

  return { implV2Address };
}
