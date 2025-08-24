import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const RouletteTestSetupModule = buildModule("RouletteTestSetup", (m) => {
  // Deploy Mock LINK Token
  const mockLinkToken = m.contract("MockLinkToken");

  // Deploy VRF Coordinator Mock
  const vrfCoordinatorMock = m.contract("VRFCoordinatorV2_5Mock", [
    100000000000000000n, // 0.1 LINK base fee
    1000000000n, // 0.000001 LINK per gas
    4_000_000_000_000_000n, // 0.004 ETH per LINK (4000000000000000 wei)
  ]);

  // Deploy Mock Automation contracts
  const mockAutomationRegistry = m.contract("MockAutomationRegistry");

  // Deploy BRB Token
  const brbToken = m.contract("BRB");

  // VRF settings for testing
  const gamePeriod = 60; // 60 seconds
  const keyHash2Gwei = "0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805";
  const keyHash30Gwei = "0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15";
  const keyHash150Gwei = "0xff8dedfbfa60af186cf3c830acbc32c05aae823045ae5ea7da1e45fbfaba4f92";
  const subscriptionId = 1n;
  const callbackGasLimit = 100000;
  const numWords = 1;
  const safeBlockConfirmation = 3;

  // Deploy StakedBRB implementation first
  const stakedBRBImpl = m.contract("StakedBRB", [brbToken, "0x0000000000000000000000000000000000000000"]);
  
  // Deploy RouletteClean implementation with placeholder StakedBRB address
  const rouletteImpl = m.contract("RouletteClean", [
    gamePeriod,
    vrfCoordinatorMock,
    keyHash2Gwei,
    keyHash30Gwei,
    keyHash150Gwei,
    subscriptionId,
    callbackGasLimit,
    numWords,
    safeBlockConfirmation,
    "0x0000000000000000000000000000000000000000", // Will be updated after deployment
  ]);

  // Deploy proxies with deterministic addresses
  const stakedBRBProxy = m.contract("ERC1967Proxy", [
    stakedBRBImpl,
    "0x", // Empty initialization data
  ], { id: "StakedBRBERC1967Proxy" });

  const rouletteProxy = m.contract("ERC1967Proxy", [
    rouletteImpl,
    "0x", // Empty initialization data
  ], { id: "RouletteCleanERC1967Proxy" });

  // Cast proxies to interfaces
  const stakedBRB = m.contractAt("StakedBRB", stakedBRBProxy, { id: "StakedBRBProxy" });
  const roulette = m.contractAt("RouletteClean", rouletteProxy, { id: "RouletteCleanProxy" });

  return {
    mockLinkToken,
    vrfCoordinatorMock,
    mockAutomationRegistry,
    brbToken,
    stakedBRB,
    roulette,
  };
});

export default RouletteTestSetupModule;