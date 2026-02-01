import hre, { viem } from "hardhat";

import { encodeAbiParameters, encodeFunctionData, getContractAddress, parseEther } from "viem";

/**
 * Script to deploy contracts to a testnet.
 * This script computes addresses off-chain, then deploys with correct constructor parameters.
 * Updated to include JackpotContract and new fee structure.
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
  const linkToken = await viem.getContractAt("MockLinkToken", LINK_TOKEN_ADDRESS);
  const vrfCoordinator = await viem.getContractAt("VRFCoordinatorV2_5Mock", VRF_COORDINATOR_ADDRESS);

  const balance = await linkToken.read.balanceOf([deployer.account.address]);

  if (balance < parseEther('10')) {
    throw new Error('Deployer does not have enough LINK to fund the subscription');
  }
  // --- VRF Subscription Creation (if needed, otherwise use existing subId) ---
  // Option 1: Create a new subscription
  console.log("Creating new VRF subscription...")
  const createSubscriptionHash = await vrfCoordinator.write.createSubscription();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createSubscriptionHash, confirmations: 2 });
  const subId = BigInt(receipt.logs[0]!.topics[1]!);

  console.log("New VRF Subscription ID:", subId);

  // Option 2: Use an existing subscription ID (uncomment and replace if preferred)
  // subId = 12345n; // Replace with your existing subscription ID

  // Ensure deployer has enough LINK to fund the subscription
  // This step assumes deployer has LINK. In a real testnet, you'd need to acquire LINK.
  // Note: IERC677's transferAndCall might have different argument types, ensure compatibility.
  const txTransferAndCall = await linkToken.write.transferAndCall([vrfCoordinator.address, parseEther('3'), encodeAbiParameters([{ type: 'uint256', name: 'subId' }], [subId])], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: txTransferAndCall, confirmations: 2 });
  console.log("Funded VRF Subscription", subId, "with 3 LINK");

  const getNonce = await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: 'latest' });

  console.log('getNonce', getNonce);
  
  // Pre-compute all contract addresses for circular dependency resolution
  const [jackpotContractImpl, brbReferalAddress, brbAddress, rouletteLibAddress, rouletteImpl, stakedBrbImpl, jackpotContractProxyAddress, rouletteProxyAddress, stakedBrbProxyAddress] = await Promise.all(Array.from({ length: 9 }, async (_, i) => {
    return getContractAddress({ 
      from: deployer.account.address,
      nonce: BigInt(getNonce + i)
    })
  }))

  // VRF Configuration
  const keyHash2Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be"
  const keyHash30Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be"
  const keyHash150Gwei = "0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be"
  const callbackGasLimit = 250000n
  const numWords = 2n
  const safeBlockConfirmation = 1
  const gamePeriod = 120n
  
  // Fee structure (basis points)
  const teamFeeBasisPoints = 300n    // 3%
  const burnFeeBasisPoints = 50n     // 0.5%
  const jackpotFeeBasisPoints = 150n // 1.5%

  // Deploy contracts in correct order
  const jackpotContract = await viem.deployContract("JackpotContract", [brbAddress, rouletteProxyAddress])
  await setTimeoutIsDeployed(jackpotContract.address);
  const brbReferal = await viem.deployContract("BRBReferal", [rouletteProxyAddress])
  await setTimeoutIsDeployed(brbReferal.address);
  const brb = await viem.deployContract("BRB")
  await setTimeoutIsDeployed(brb.address);

  console.log('brb is deployed', brb.address);
  
  // Create RouletteClean parameters object
  const params = {
    gamePeriod,
    vrfCoordinator: VRF_COORDINATOR_ADDRESS,
    keyHash2Gwei,
    keyHash30Gwei,
    keyHash150Gwei,
    subscriptionId: subId,
    callbackGasLimit,
    numWords,
    safeBlockConfirmation,
    stakedBRBContract: stakedBrbProxyAddress,
    linkToken: LINK_TOKEN_ADDRESS,
    jackpotContract: jackpotContractProxyAddress,
    brbToken: brbAddress
  }
  
  const rouletteLib = await viem.deployContract("RouletteLib");
  await setTimeoutIsDeployed(rouletteLib.address);
  
  const rouletteCleanFactory = await viem.deployContract("RouletteClean", [params], {
    libraries: {
      RouletteLib: rouletteLib.address
    }
  });
  
  await setTimeoutIsDeployed(rouletteCleanFactory.address);
  const stakedBrbFactory = await viem.deployContract("StakedBRB", [brbAddress, rouletteProxyAddress, brbReferalAddress, jackpotContractProxyAddress]);
  await setTimeoutIsDeployed(stakedBrbFactory.address);
  
  // Prepare initialization data
  const initializeJackpotContractData = encodeFunctionData({
    abi: jackpotContract.abi,
    functionName: 'initialize',
    args: [deployer.account.address]
  })

  const initializeRouletteData = encodeFunctionData({
    abi: rouletteCleanFactory.abi,
    functionName: 'initialize',
    args: [parseEther('1'), deployer.account.address, AUTOMATION_REGISTRAR_ADDRESS, AUTOMATION_REGISTRY_ADDRESS, LINK_TOKEN_ADDRESS]
  });

  const initializeStakedBrbData = encodeFunctionData({
    abi: stakedBrbFactory.abi,
    functionName: 'initialize',
    args: [deployer.account.address, teamFeeBasisPoints, burnFeeBasisPoints, jackpotFeeBasisPoints, deployer.account.address]
  });
  // Deploy proxies (must wait for each to be mined to avoid nonce conflicts)
  const _jackpotContractProxy = await viem.deployContract("ERC1967Proxy", [jackpotContractImpl, initializeJackpotContractData])
  await setTimeoutIsDeployed(_jackpotContractProxy.address);
  
  const rouletteProxyContract = await viem.deployContract("ERC1967Proxy", [rouletteImpl, initializeRouletteData])
  await setTimeoutIsDeployed(rouletteProxyContract.address);
  
  const stakedBrbProxyContract = await viem.deployContract("ERC1967Proxy", [stakedBrbImpl, initializeStakedBrbData])
  await setTimeoutIsDeployed(stakedBrbProxyContract.address);
  // Get contract instances
  const jackpotContractProxy = await viem.getContractAt("JackpotContract", _jackpotContractProxy.address)
  const rouletteProxy = await viem.getContractAt("RouletteClean", rouletteProxyAddress);
  const stakedBrbProxy = await viem.getContractAt("StakedBRB", stakedBrbProxyAddress);

  // Setup Chainlink for StakedBRB
  await stakedBrbProxy.write.setupChainlink([AUTOMATION_REGISTRAR_ADDRESS, AUTOMATION_REGISTRY_ADDRESS, LINK_TOKEN_ADDRESS])
  let tx = await linkToken.write.approve([stakedBrbProxy.address, parseEther('1')], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  const cleaningUpkeepId = await stakedBrbProxy.write.registerCleaningUpkeep([parseEther('1')])
  
  // Add VRF consumer
  tx = await vrfCoordinator.write.addConsumer([subId, rouletteProxyAddress], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  
  // Register upkeeps for RouletteClean
  const upkeepCount = 20n; // Register 20 payout upkeeps
  const linkAmount = parseEther('0.2'); // 1 LINK per upkeep
  tx = await linkToken.write.approve([rouletteProxy.address, linkAmount * upkeepCount + linkAmount * 2n], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  
  tx = await rouletteProxy.write.registerVRFUpkeep([linkAmount], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  
  tx = await rouletteProxy.write.registerPayoutUpkeeps([upkeepCount, linkAmount], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  tx = await rouletteProxy.write.registerComputeTotalWinningBetsUpkeep([linkAmount], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 2 });


  await sleep(30 * 1000);

  // Verify all address matches
  if (jackpotContract.address.toLowerCase() !== jackpotContractImpl.toLowerCase()) {
    throw new Error('Jackpot contract address mismatch')
  }
  if (jackpotContractProxy.address.toLowerCase() !== jackpotContractProxyAddress.toLowerCase()) {
    throw new Error('Jackpot contract proxy address mismatch')
  }
  if (brbReferalAddress.toLowerCase() !== brbReferal.address.toLowerCase()) {
    throw new Error('BRB Referral address mismatch')
  }
  if (rouletteProxy.address.toLowerCase() !== rouletteProxyAddress.toLowerCase()) {
    throw new Error('Roulette proxy address mismatch');
  }
  if (stakedBrbProxy.address.toLowerCase() !== stakedBrbProxyAddress.toLowerCase()) {
    throw new Error('Staked BRB proxy address mismatch');
  }
  if (rouletteCleanFactory.address.toLowerCase() !== rouletteImpl.toLowerCase()) {
    throw new Error('Roulette implementation address mismatch');
  }
  if (stakedBrbFactory.address.toLowerCase() !== stakedBrbImpl.toLowerCase()) {
    throw new Error('Staked BRB implementation address mismatch');
  }
  if (brb.address.toLowerCase() !== brbAddress.toLowerCase()) {
    throw new Error('BRB address mismatch');
  }

  const verificationTimeout = 10000;
  try {
    await hre.run("verify:verify", {
      address: jackpotContractImpl,
      constructorArguments: [brbAddress, rouletteProxyAddress]
    });
  } catch (error) {
    console.log('Error verifying jackpotContractImpl', error);
  }
  await sleep(verificationTimeout);
  
  try {
    await hre.run("verify:verify", {
      address: rouletteImpl,
      constructorArguments: [params]
    });
  } catch (error) {
    console.log('Error verifying rouletteImpl', error);
  }
  await sleep(verificationTimeout);
  
  try {
    await hre.run("verify:verify", {
      address: stakedBrbImpl,
      constructorArguments: [brbAddress, rouletteProxyAddress, brbReferalAddress, jackpotContractProxyAddress]
    });
  } catch (error) {
    console.log('Error verifying stakedBrbImpl', error);
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
      constructorArguments: [stakedBrbImpl, initializeStakedBrbData]
    });
  } catch (error) {
    console.log('Error verifying stakedBrbProxy', error);
  }

  await sleep(verificationTimeout);

  try {
    await hre.run("verify:verify", {
      address: rouletteProxyAddress,
      constructorArguments: [rouletteImpl, initializeRouletteData]
    });
  } catch (error) {
    console.log('Error verifying rouletteProxy', error);
  }

  await sleep(verificationTimeout);

  try {
    await hre.run("verify:verify", {
      address: brbReferalAddress,
      constructorArguments: [rouletteProxyAddress]
    });
  } catch (error) {
    console.log('Error verifying brbReferal', error);
  }
  
  await sleep(verificationTimeout);
  
  try {
    await hre.run("verify:verify", {
      address: jackpotContractProxyAddress,
      constructorArguments: [jackpotContractImpl, initializeJackpotContractData]
    });
  } catch (error) {
    console.log('Error verifying jackpotContractProxy', error);
  }

  await sleep(verificationTimeout);
  
  try {
    await hre.run("verify:verify", {
      address: rouletteLibAddress,
    });
  } catch (error) {
    console.log('Error verifying rouletteLib', error);
  }

  

  console.log('=== DEPLOYMENT COMPLETE ===');
  console.log('jackpotContractProxy', jackpotContractProxy.address);
  console.log('rouletteProxyAddress', rouletteProxyAddress);
  console.log('stakedBrbProxyAddress', stakedBrbProxyAddress);
  console.log('rouletteLibAddress', rouletteLibAddress);
  console.log('jackpotContractImpl', jackpotContractImpl);
  console.log('rouletteImpl', rouletteImpl);
  console.log('stakedBrbImpl', stakedBrbImpl);
  console.log('brbReferal', brbReferal.address);
  console.log('brb', brb.address);
  console.log('automationRegistry', AUTOMATION_REGISTRY_ADDRESS);
  console.log('linkToken', LINK_TOKEN_ADDRESS);
  console.log('cleaningUpkeepId', cleaningUpkeepId);

  const getUpkeepConfig = await rouletteProxy.read.getUpkeepConfig();
  console.log('getUpkeepConfig', getUpkeepConfig);

  return {
    rouletteProxy,
    stakedBrbProxy,
    jackpotContract: jackpotContractProxy,
    vrfCoordinator,
    automationRegistryAddress: AUTOMATION_REGISTRY_ADDRESS,
    linkTokenAddress: LINK_TOKEN_ADDRESS,
    subId,
    brb
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
