import hre, { viem } from "hardhat";

import { encodeAbiParameters, encodeFunctionData, getContractAddress, parseEther } from "viem";

import { abi as rouletteCleanAbi } from "../artifacts/contracts/RouletteClean.sol/abi";
import { abi as stakedBrbAbi } from "../artifacts/contracts/StakedBRB.sol/abi";
// If AggregatorV3Interface and VRFCoordinatorV2_5Interface are not available as Solidity interfaces, you might need to
// define minimal ABIs here or ensure they are compiled and available through Hardhat.

/**
 * Script to deploy contracts to a testnet using CREATE2.
 * This script computes addresses off-chain, then deploys with correct constructor parameters.
 */


function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isEoa(address: `0x${string}`) {
  const publicClient = await viem.getPublicClient()

    const balance = await publicClient.getCode({ address });
    return balance === '0x';
}

async function setTimeoutIsDeployed(address: `0x${string}`) {
  while (await isEoa(address)) {
    await sleep(5 * 1000);
  }
  return true;
}

async function deployTestnet() {
  const publicClient = await viem.getPublicClient()
  const [deployer] = await viem.getWalletClients() 

  // --- Chainlink Testnet Addresses (PLACEHOLDERS - REPLACE WITH ACTUAL TESTNET ADDRESSES) ---
  // Consult Chainlink documentation for the correct addresses for your target testnet (e.g., Sepolia)
  const AUTOMATION_REGISTRAR_ADDRESS = "0x881918E24290084409DaA91979A30e6f0dB52eBe" as `0x${string}`; // Replace with actual Automation Registry address
  const AUTOMATION_REGISTRY_ADDRESS = "0x8194399B3f11fcA2E8cCEfc4c9A658c61B8Bf412" as `0x${string}`; // Replace with actual Automation Registry address
  const LINK_TOKEN_ADDRESS = "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E" as `0x${string}`; // Replace with actual LINK Token address
  const VRF_COORDINATOR_ADDRESS = "0x5CE8D5A2BC84beb22a398CCA51996F7930313D61" as `0x${string}`; // Replace with actual VRFCoordinatorV2_5 address

  // Get contract instances for existing Chainlink services on testnet
  const linkToken = await viem.getContractAt("ERC1363", LINK_TOKEN_ADDRESS);
  // For AggregatorV3 and VRFCoordinatorV2_5, if no explicit interface files, you might need to pass their ABIs explicitly.
  // For now, using generic Contract type or a minimal ABI for the functions called.
  // If `viem.getContractAt` cannot infer the type, you may need to define a minimal ABI or import from Chainlink's npm package.
  const vrfCoordinator = await viem.getContractAt("VRFCoordinatorV2_5Mock", VRF_COORDINATOR_ADDRESS); // Using Mock interface for now, replace with actual if available

  const balance = await linkToken.read.balanceOf([deployer.account.address]);

  if (balance < parseEther('10')) {
    throw new Error('Deployer does not have enough LINK to fund the subscription');
  }
  // --- VRF Subscription Creation (if needed, otherwise use existing subId) ---
  // Option 1: Create a new subscription
  console.log("Creating new VRF subscription...")
  const createSubscriptionHash = await vrfCoordinator.write.createSubscription();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createSubscriptionHash });
  const subId = BigInt(receipt.logs[0]!.topics[1]!);
  console.log("New VRF Subscription ID:", subId);

  // Option 2: Use an existing subscription ID (uncomment and replace if preferred)
  // subId = 12345n; // Replace with your existing subscription ID

  // Ensure deployer has enough LINK to fund the subscription
  // This step assumes deployer has LINK. In a real testnet, you'd need to acquire LINK.
  // Note: IERC677's transferAndCall might have different argument types, ensure compatibility.
  const txTransferAndCall = await linkToken.write.transferAndCall([vrfCoordinator.address, parseEther('3'), encodeAbiParameters([{ type: 'uint256', name: 'subId' }], [subId])], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txTransferAndCall });
  console.log("Funded VRF Subscription", subId, "with 3 LINK");

  const getNonce = await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: 'latest' });

  console.log('getNonce', getNonce);
  const brbReferalAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce),
    opcode: 'CREATE'
  });

  const brbAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce + 1),
    opcode: 'CREATE'
  });

  const rouletteImplAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce + 2),
    opcode: 'CREATE'
  });

  const stakedBrbImplAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce + 3),
    opcode: 'CREATE'
  });

  const rouletteProxyAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce + 4),
    opcode: 'CREATE'
  });

  const stakedBrbProxyAddress = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(getNonce + 5),
    opcode: 'CREATE'
  });

  const keyHash2Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash for Chainlink VRF
  const keyHash30Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash
  const keyHash150Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash
  const callbackGasLimit = 300000n
  const numWords = 1n
  const safeBlockConfirmation = 1;
  const gamePeriod = 60n;

  const brbReferal = await viem.deployContract("BRBReferal");

  const brb = await viem.deployContract("BRB", []);
  await setTimeoutIsDeployed(brb.address);

  console.log('brb is dployed', brb.address);
  const initializeRouletteData = encodeFunctionData({
    abi: rouletteCleanAbi,
    functionName: 'initialize',
    args: [deployer.account.address, AUTOMATION_REGISTRAR_ADDRESS, AUTOMATION_REGISTRY_ADDRESS, LINK_TOKEN_ADDRESS]
  });

  const initializeStakedBrbData = encodeFunctionData({
    abi: stakedBrbAbi,
    functionName: 'initialize',
    args: [deployer.account.address, 250n, deployer.account.address] // Changed from 10000 to 250 (2.5%)
  });

  const rouletteCleanFactory = await viem.deployContract("RouletteClean", [gamePeriod, VRF_COORDINATOR_ADDRESS, keyHash2Gwei, keyHash30Gwei, keyHash150Gwei, subId, callbackGasLimit, numWords, safeBlockConfirmation, stakedBrbProxyAddress]);
  
  if (brbReferalAddress.toLowerCase() !== brbReferal.address.toLowerCase()) {
    throw new Error('BRB Referral address mismatch');
  }

  if (rouletteCleanFactory.address.toLowerCase() !== rouletteImplAddress.toLowerCase()) {
    throw new Error('Roulette implementation address mismatch');
  }

  await setTimeoutIsDeployed(rouletteCleanFactory.address);
  const stakedBrbFactory = await viem.deployContract("StakedBRB", [brbAddress, rouletteProxyAddress, brbReferalAddress]);
  if (stakedBrbFactory.address.toLowerCase() !== stakedBrbImplAddress.toLowerCase()) {
    throw new Error('Staked BRB implementation address mismatch');
  }
  await setTimeoutIsDeployed(stakedBrbFactory.address);
  const proxyFactory = await viem.deployContract("ERC1967Proxy", [rouletteImplAddress, initializeRouletteData]);

  if (proxyFactory.address.toLowerCase() !== rouletteProxyAddress.toLowerCase()) {
    throw new Error('Roulette proxy address mismatch');
  }

  await setTimeoutIsDeployed(proxyFactory.address);
  const stakedBrbProxyFactory = await viem.deployContract("ERC1967Proxy", [stakedBrbImplAddress, initializeStakedBrbData]);

  if (stakedBrbProxyFactory.address.toLowerCase() !== stakedBrbProxyAddress.toLowerCase()) {
    throw new Error('Staked BRB proxy address mismatch');
  }

  await setTimeoutIsDeployed(stakedBrbProxyFactory.address);
  const rouletteProxy = await viem.getContractAt("RouletteClean", rouletteProxyAddress);
  const stakedBrbProxy = await viem.getContractAt("StakedBRB", stakedBrbProxyAddress);

  let tx = await linkToken.write.approve([rouletteProxy.address, parseEther('6')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await rouletteProxy.write.registerVRFUpkeep([parseEther('1')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await rouletteProxy.write.registerComputeTotalWinningBetsUpkeep([parseEther('1')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await rouletteProxy.write.registerPayoutUpkeeps([20n, parseEther('0.2')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  
  tx = await stakedBrbProxy.write.setupChainlink([AUTOMATION_REGISTRAR_ADDRESS, AUTOMATION_REGISTRY_ADDRESS, LINK_TOKEN_ADDRESS], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await linkToken.write.approve([stakedBrbProxy.address, parseEther('1')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await stakedBrbProxy.write.registerCleaningUpkeep([parseEther('1')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await vrfCoordinator.write.addConsumer([subId, rouletteProxyAddress], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx });


  await sleep(30 * 1000);

  if (rouletteProxy.address.toLowerCase() !== rouletteProxyAddress.toLowerCase()) {
    throw new Error('Roulette proxy address mismatch');
  }
  if (stakedBrbProxy.address.toLowerCase() !== stakedBrbProxyAddress.toLowerCase()) {
    throw new Error('Staked BRB proxy address mismatch');
  }

  if (stakedBrbFactory.address.toLowerCase() !== stakedBrbImplAddress.toLowerCase()) {
    throw new Error('Staked BRB implementation address mismatch');
  }

  if (brb.address.toLowerCase() !== brbAddress.toLowerCase()) {
    throw new Error('BRB address mismatch');
  }

  const verificationTimeout = 10000;
  try {
  await hre.run("verify:verify", {
    address: rouletteImplAddress,
    constructorArguments: [gamePeriod, VRF_COORDINATOR_ADDRESS, keyHash2Gwei, keyHash30Gwei, keyHash150Gwei, subId, callbackGasLimit, numWords, safeBlockConfirmation, stakedBrbProxyAddress]
  });
  } catch (error) {
    console.log('Error verifying rouletteImplAddress', error);
  }
  await sleep(verificationTimeout);
  try {
    await hre.run("verify:verify", {
      address: stakedBrbImplAddress,
      constructorArguments: [brbAddress, rouletteProxyAddress, brbReferalAddress]
    });
  } catch (error) {
    console.log('Error verifying stakedBrbImplAddress', error);
  }
  await sleep(verificationTimeout);
  try {
    await hre.run("verify:verify", {
      address: brbAddress,
    });
  } catch (error) {
    console.log('Error verifying brb', error);
  }

  await sleep(verificationTimeout);

  try {
    await hre.run("verify:verify", {
      address: stakedBrbProxyAddress,
      constructorArguments: [stakedBrbImplAddress, initializeStakedBrbData]
    });
  } catch (error) {
    console.log('Error verifying stakedBrbProxy', error);
  }

  await sleep(verificationTimeout);

  try {
    await hre.run("verify:verify", {
      address: rouletteProxyAddress,
      constructorArguments: [rouletteImplAddress, initializeRouletteData]
    });
  } catch (error) {
    console.log('Error verifying rouletteProxy', error);
  }

  await sleep(verificationTimeout);

  try {
    await hre.run("verify:verify", {
      address: brbReferalAddress,
      constructorArguments: []
    });
  } catch (error) {
    console.log('Error verifying rouletteProxy', error);
  }

  

  console.log('rouletteProxyAddress', rouletteProxyAddress);
  console.log('stakedBrbProxyAddress', stakedBrbProxyAddress);
  console.log('rouletteImpl', rouletteImplAddress);
  console.log('stakedBrbImpl', stakedBrbImplAddress);
  console.log('brb', brb.address);
  console.log('automationRegistry', AUTOMATION_REGISTRY_ADDRESS);
  console.log('linkToken', LINK_TOKEN_ADDRESS);

  const getUpkeepConfig = await rouletteProxy.read.getUpkeepConfig();
  console.log('getUpkeepConfig', getUpkeepConfig);

  return {
    rouletteProxy,
    stakedBrbProxy,
    vrfCoordinator, // Return vrfCoordinator instance if needed for further interactions
    automationRegistryAddress: AUTOMATION_REGISTRY_ADDRESS,
    linkTokenAddress: LINK_TOKEN_ADDRESS,
    subId,
    brb,
  }
}

if (require.main === module) {
  deployTestnet()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { deployTestnet };
