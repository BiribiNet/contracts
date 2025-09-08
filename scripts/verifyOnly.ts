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
  // For AggregatorV3 and VRFCoordinatorV2_5, if no explicit interface files, you might need to pass their ABIs explicitly.
  // For now, using generic Contract type or a minimal ABI for the functions called.
  // If `viem.getContractAt` cannot infer the type, you may need to define a minimal ABI or import from Chainlink's npm package.
  const vrfCoordinator = await viem.getContractAt("VRFCoordinatorV2_5Mock", VRF_COORDINATOR_ADDRESS); // Using Mock interface for now, replace with actual if available

  const getNonce = await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: 'latest' });

  console.log('getNonce', getNonce);

  const rouletteImplAddress = "0xb09476DA20CA3Df6AA660184961E65ef96EB2dBC"

  const stakedBrbImplAddress = "0xdf2a80DdAeaF07AdA88d7b3F31edda788948EeC8"

  const rouletteProxyAddress = "0x5A4D9D411132d4247B0e0e7C5175dAc4104D7c85"

  const stakedBrbProxyAddress = "0x049E244A074234E4596f17f76Ca8Ff9CD78E3AB2"

  const brb = "0x485295dedd3d416f2324f4ae07d51f70e516ac57"

  const subId = 100861783258177609004941587294708163389386576030640366580929760818517555028236n;

  const keyHash2Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash for Chainlink VRF
  const keyHash30Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash
  const keyHash150Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be" // Example Key Hash
  const callbackGasLimit = 300000n
  const numWords = 1n
  const safeBlockConfirmation = 1;
  const gamePeriod = 60n;


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


  const rouletteProxy = await viem.getContractAt("RouletteClean", rouletteProxyAddress);
  const stakedBrbProxy = await viem.getContractAt("StakedBRB", stakedBrbProxyAddress);

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
      constructorArguments: [brb, rouletteProxyAddress]
    });
  } catch (error) {
    console.log('Error verifying stakedBrbImplAddress', error);
  }
  await sleep(verificationTimeout);
  try {
    await hre.run("verify:verify", {
      address: brb,
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

  console.log('rouletteProxyAddress', rouletteProxyAddress);
  console.log('stakedBrbProxyAddress', stakedBrbProxyAddress);
  console.log('rouletteImpl', rouletteImplAddress);
  console.log('stakedBrbImpl', stakedBrbImplAddress);
  console.log('brb', brb);
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
