import hre from "hardhat";

// If AggregatorV3Interface and VRFCoordinatorV2_5Interface are not available as Solidity interfaces, you might need to
// define minimal ABIs here or ensure they are compiled and available through Hardhat.

/**
 * Script to deploy contracts to a testnet using CREATE2.
 * This script computes addresses off-chain, then deploys with correct constructor parameters.
 */

async function deployTestnet() {
  const rouletteImplAddress = "0xbaCBB6d3e3df6026F0E81C576a48a6f7E688Fa5d"

  const stakedBrbImplAddress = "0x16c4161d23331249688cf3b0e8A6AE4a73CEaddD"

  const rouletteProxyAddress = "0xe9303160761785f164503a021d07339881b6e422"

  // await hre.tenderly.verify({
  //   name: 'RouletteClean',
  //   address: rouletteProxyAddress,
  //   network: 'arbitrumsepolia',
  //   libraries: {
  //     RouletteLib: "0x6d24f1546f82207a5d0bf56391707c8064cabb70",
  //   }
  // });

  await hre.tenderly.verify({
    name: 'StakedBRB',
    address: stakedBrbImplAddress,
    network: 'arbitrumsepolia'
  });


  console.log('=== VERIFICATION COMPLETE ===');
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
