import { viem } from "hardhat";

import { encodeFunctionData, getContractAddress, parseEther } from "viem";

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
    100000000000000000n, // 0.1 LINK base fee
    1000000n, // 0.000001 LINK per gas
    4_000_000_000_000_000n]); // 0.004 ETH per LINK])
  await vrfCoordinator.write.setLINKAndLINKNativeFeed([mockLinkToken.address, aggregator.address])
  const createSubscriptionHash = await vrfCoordinator.write.createSubscription()
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createSubscriptionHash })
  const subId = BigInt(receipt.logs[0]!.topics[1]!)

  const getNonce = await publicClient.getTransactionCount({ address: deployer.account.address })
  
  const [brbAddress, rouletteImpl, stakedBrbImpl, rouletteProxyAddress, stakedBrbProxyAddress] = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
    return getContractAddress({ 
      from: deployer.account.address,
      nonce: BigInt(getNonce + i)
    })
  }))

  const brb = await viem.deployContract("BRB") // #1

  const keyHash2Gwei = "0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805"
  const keyHash30Gwei = "0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15"
  const keyHash150Gwei = "0xff8dedfbfa60af186cf3c830acbc32c05aae823045ae5ea7da1e45fbfaba4f92"
  const callbackGasLimit = 100000n
  const numWords = 1n
  const safeBlockConfirmation = 3;
  const gamePeriod = 60n;
  const roulette = await viem.deployContract("RouletteClean", [gamePeriod, vrfCoordinator.address, keyHash2Gwei, keyHash30Gwei, keyHash150Gwei, subId, callbackGasLimit, numWords, safeBlockConfirmation, stakedBrbProxyAddress]) // #2
  const stakedBrb = await viem.deployContract("StakedBRB", [brbAddress, rouletteProxyAddress]) // #3

  const initializeRouletteData = encodeFunctionData({
    abi: roulette.abi,
    functionName: 'initialize',
    args: [deployer.account.address, mockAutomationRegistry.address, mockAutomationRegistry.address, mockLinkToken.address]
  })

  const initializeStakedBrbData = encodeFunctionData({
    abi: stakedBrb.abi,
    functionName: 'initialize',
    args: [deployer.account.address, 10000n, deployer.account.address]
  })

  const rouletteProxyContract = await viem.deployContract("ERC1967Proxy", [rouletteImpl, initializeRouletteData]) // #2
  const stakedBrbProxyContract = await viem.deployContract("ERC1967Proxy", [stakedBrbImpl, initializeStakedBrbData]) // #3

  const rouletteProxy = await viem.getContractAt("RouletteClean", rouletteProxyAddress)
  const stakedBrbProxy = await viem.getContractAt("StakedBRB", stakedBrbProxyAddress)
  await vrfCoordinator.write.addConsumer([subId, rouletteProxyAddress])

  // fund subscription
  await mockLinkToken.write.approve([vrfCoordinator.address, parseEther('1')])
  await vrfCoordinator.write.fundSubscription([subId, parseEther('1')])

  // Register VRF upkeep
  const approveRoulette = await mockLinkToken.write.approve([rouletteProxyAddress, parseEther('1')])
  await rouletteProxy.write.registerVRFUpkeep([parseEther('1')])

  // Register payout upkeeps
  const approvePayout = await mockLinkToken.write.approve([rouletteProxyAddress, parseEther('10')])
  const payoutUpkeeps = await rouletteProxy.write.registerPayoutUpkeeps([10n, parseEther('1')])

  console.log('rouletteProxyAddress', rouletteProxyAddress)
  console.log('stakedBrbProxyAddress', stakedBrbProxyAddress)
  console.log('rouletteImpl', rouletteImpl)
  console.log('stakedBrbImpl', stakedBrbImpl)
  console.log('brb', brb.address)
  console.log('mockAutomationRegistry', mockAutomationRegistry.address)
  console.log('mockLinkToken', mockLinkToken.address)

  const getUpkeepConfig = await rouletteProxy.read.getUpkeepConfig()
  console.log('getUpkeepConfig', getUpkeepConfig)

  await brb.write.transfer([player1.account.address, parseEther('1000')], { account: deployer.account })
  return {
    rouletteProxy,
    stakedBrbProxy,
    vrfCoordinator,
    mockAutomationRegistry,
    mockLinkToken,
    subId,
    brb
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
