import { viem } from "hardhat";

import { encodeAbiParameters, encodeFunctionData, getContractAddress, parseEther } from "viem";

/**
 * Script to deploy contracts with CREATE2 to solve circular dependency
 * This script computes addresses off-chain, then deploys with correct constructor parameters
 */
async function deployWithCreate() {
  const publicClient = await viem.getPublicClient()
  const [deployer, player1] = await viem.getWalletClients()

  const mockAutomationRegistry = await viem.deployContract("MockKeeperRegistry", [])

  const mockLinkToken = await viem.deployContract("MockLinkToken")
  const aggregator = await viem.deployContract("AggregatorV3Mock")

  
  const vrfCoordinator = await viem.deployContract("VRFCoordinatorV2_5Mock", [
    10000000000000n, // 0.1 LINK base fee
    1000000000000000000n, // 0.000001 LINK per gas
    4_000_000_000_000_000_000_000_000n]); // 0.004 ETH per LINK])
  await vrfCoordinator.write.setLINKAndLINKNativeFeed([mockLinkToken.address, aggregator.address])
  const createSubscriptionHash = await vrfCoordinator.write.createSubscription()
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createSubscriptionHash })
  const subId = BigInt(receipt.logs[0]!.topics[1]!)

  const getNonce = await publicClient.getTransactionCount({ address: deployer.account.address })
  
  // 0: jackpot, 1: brbReferal, 2: brb, 3: rouletteLib, 4: upkeepManager, 5: rouletteImpl, 6: stakedBrbImpl, 7: jackpot proxy, 8: stakedBrb proxy, 9: roulette proxy (StakedBRB must init before Roulette so boundary timestamps align)
  const [
    jackpotContractImpl,
    brbReferalAddress,
    brbAddress,
    rouletteLibAddress,
    upkeepManagerAddress,
    rouletteImpl,
    stakedBrbImpl,
    jackpotContractProxyAddress,
    stakedBrbProxyAddress,
    rouletteProxyAddress
  ] = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    return getContractAddress({ 
      from: deployer.account.address,
      nonce: BigInt(getNonce + i)
    })
  }))

  const jackpotContract = await viem.deployContract("JackpotContract", [brbAddress, rouletteProxyAddress])
  const brbReferal = await viem.deployContract("BRBReferal", [stakedBrbProxyAddress]) // #1
  const brb = await viem.deployContract("BRB", []) // #2

  const keyHash2Gwei = "0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805"
  const keyHash30Gwei = "0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15"
  const keyHash150Gwei = "0xff8dedfbfa60af186cf3c830acbc32c05aae823045ae5ea7da1e45fbfaba4f92"
  const callbackGasLimit = 100000n
  const numWords = 2n;
  const safeBlockConfirmation = 3;
  // Large enough that multi-tx fixture deploy does not advance block time past one period
  // (StakedBRB rejects deposits when elapsed >= gamePeriod since lastRoundBoundaryTimestamp)
  const gamePeriod = 100_000n;
  const teamFeeBasisPoints = 300n;
  const burnFeeBasisPoints = 50n;
  const jackpotFeeBasisPoints = 150n;

  const rouletteLib = await viem.deployContract("RouletteLib");

  const upkeepManager = await viem.deployContract("BRBUpkeepManager", [
    rouletteProxyAddress,
    stakedBrbProxyAddress,
    mockLinkToken.address,
    mockAutomationRegistry.address,
    mockAutomationRegistry.address,
    deployer.account.address,
    deployer.account.address,
  ])

  if (upkeepManager.address.toLowerCase() !== upkeepManagerAddress.toLowerCase()) {
    throw new Error('BRBUpkeepManager address mismatch')
  }

  const params = {
    gamePeriod,
    vrfCoordinator: vrfCoordinator.address,
    keyHash2Gwei,
    keyHash30Gwei,
    keyHash150Gwei,
    subscriptionId: subId,
    callbackGasLimit,
    numWords,
    safeBlockConfirmation,
    stakedBRBContract: stakedBrbProxyAddress,
    linkToken: mockLinkToken.address,
    jackpotContract: jackpotContractProxyAddress,
    brbToken: brbAddress,
    upkeepManager: upkeepManager.address,
  }
  const roulette = await viem.deployContract("RouletteClean", [params], {
    libraries: {
      RouletteLib: rouletteLib.address,
    },
  }) // #5
  const stakedBrb = await viem.deployContract("StakedBRB", [
    brbAddress,
    rouletteProxyAddress,
    brbReferalAddress,
    jackpotContractProxyAddress,
    upkeepManager.address,
  ]) // #6

  const initializeJackpotContractData = encodeFunctionData({
    abi: jackpotContract.abi,
    functionName: 'initialize',
    args: [deployer.account.address]
  })

  const initializeRouletteData = encodeFunctionData({
    abi: roulette.abi,
    functionName: 'initialize',
    args: [parseEther('1'), deployer.account.address]
  })

  const initializeStakedBrbData = encodeFunctionData({
    abi: stakedBrb.abi,
    functionName: 'initialize',
    args: [deployer.account.address, teamFeeBasisPoints, burnFeeBasisPoints, jackpotFeeBasisPoints, deployer.account.address] // Changed from 10000 to 250 (2.5%)
  })

  const _jackpotContractProxy = await viem.deployContract("ERC1967Proxy", [jackpotContractImpl, initializeJackpotContractData]) // #7
  const stakedBrbProxyContract = await viem.deployContract("ERC1967Proxy", [stakedBrbImpl, initializeStakedBrbData]) // #8 — before Roulette so lastRoundBoundaryTimestamp is set
  const rouletteProxyContract = await viem.deployContract("ERC1967Proxy", [rouletteImpl, initializeRouletteData]) // #9

  const jackpotContractProxy = await viem.getContractAt("JackpotContract", _jackpotContractProxy.address)
  const rouletteProxy = await viem.getContractAt("RouletteClean", rouletteProxyAddress)
  const stakedBrbProxy = await viem.getContractAt("StakedBRB", stakedBrbProxyAddress)
  
  const liquidityEscrow = await viem.deployContract("StakedBRBLiquidityEscrow", [brbAddress, stakedBrbProxyAddress])
  await stakedBrbProxy.write.setLiquidityEscrow([liquidityEscrow.address])
  await mockLinkToken.write.approve([upkeepManager.address, parseEther('1')], { account: deployer.account })
  const cleaningUpkeepId = await upkeepManager.write.registerStakedBrbCleaningUpkeep([parseEther('1')], {
    account: deployer.account,
  })
  await vrfCoordinator.write.addConsumer([subId, rouletteProxyAddress])

  // fund subscription
  await mockLinkToken.write.approve([vrfCoordinator.address, parseEther('1')])

  await mockLinkToken.write.setBalance([deployer.account.address, parseEther('1000')])
  const data = encodeAbiParameters([{ type: 'uint256', name: 'subId' }], [subId]);
  await mockLinkToken.write.transferAndCall([vrfCoordinator.address, parseEther('10'), data])
  // Register upkeeps via BRBUpkeepManager (REGISTRANT_ROLE)
  const upkeepCount = 20n; // Register 20 payout upkeeps
  const linkAmount = parseEther('10'); // 10 LINK per upkeep
  await mockLinkToken.write.approve([upkeepManager.address, linkAmount * upkeepCount + linkAmount * 3n], { account: deployer.account }); // Payout + VRF + compute + cleaning
  await upkeepManager.write.registerVRFUpkeep([parseEther('1')], { account: deployer.account })
  const upkeepIds = await upkeepManager.write.registerPayoutUpkeeps([upkeepCount, linkAmount], { account: deployer.account });
  const upkeepIdsComputeTotalWinningBets = await upkeepManager.write.registerComputeTotalWinningBetsUpkeep([linkAmount], { account: deployer.account });


  console.log('rouletteProxyAddress', rouletteProxyAddress)
  console.log('stakedBrbProxyAddress', stakedBrbProxyAddress)
  console.log('rouletteLibAddress', rouletteLibAddress)
  console.log('rouletteImpl', rouletteImpl)
  console.log('stakedBrbImpl', stakedBrbImpl)
  console.log('brb', brb.address)
  console.log('mockAutomationRegistry', mockAutomationRegistry.address)
  console.log('mockLinkToken', mockLinkToken.address)
  console.log('cleaningUpkeepId', cleaningUpkeepId) // Log the cleaning upkeep ID
  console.log('upkeepManager', upkeepManager.address)

  const getUpkeepConfig = await rouletteProxy.read.getUpkeepConfig()
  console.log('getUpkeepConfig', getUpkeepConfig)

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
    throw new Error('Roulette proxy address mismatch')
  }
  if (stakedBrbProxy.address.toLowerCase() !== stakedBrbProxyAddress.toLowerCase()) {
    throw new Error('Staked BRB proxy mismatch')
  }

  if (roulette.address.toLowerCase() !== rouletteImpl.toLowerCase()) {
    throw new Error('Roulette address mismatch')
  }
  if (stakedBrb.address.toLowerCase() !== stakedBrbImpl.toLowerCase()) {
    throw new Error('Staked BRB address mismatch')
  }

  if (brb.address.toLowerCase() !== brbAddress.toLowerCase()) {
    throw new Error('BRB address mismatch')
  }

  // Ensure deployer has a large initial BRB balance for funding players in tests
  await brb.write.transfer([deployer.account.address, parseEther('1000000')], { account: deployer.account });

  // Fund all relevant player accounts directly in the fixture
  const [, p1, p2, p3, p4, p5] = await viem.getWalletClients(); // Get all player clients
  const initialPlayerFundingAmount = parseEther('15000'); // Increased to cover 10000 token deposits + betting

  await brb.write.transfer([p1.account.address, initialPlayerFundingAmount], { account: deployer.account });
  await brb.write.transfer([p2.account.address, initialPlayerFundingAmount], { account: deployer.account });
  await brb.write.transfer([p3.account.address, initialPlayerFundingAmount], { account: deployer.account });
  await brb.write.transfer([p4.account.address, initialPlayerFundingAmount], { account: deployer.account });
  await brb.write.transfer([p5.account.address, initialPlayerFundingAmount], { account: deployer.account });

  return {
    rouletteProxy,
    stakedBrbProxy,
    upkeepManager,
    jackpotContract: jackpotContractProxy,
    vrfCoordinator,
    mockAutomationRegistry,
    mockLinkToken,
    subId,
    brb,
    cleaningUpkeepId, // Return the cleaning upkeepId from the fixture
    payoutUpkeepIds: upkeepIds, // Return payout upkeep IDs
    computeTotalWinningBetsUpkeepId: upkeepIdsComputeTotalWinningBets // Return compute total winning bets upkeep ID
  }




}

if (require.main === module) {
  deployWithCreate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { deployWithCreate };
