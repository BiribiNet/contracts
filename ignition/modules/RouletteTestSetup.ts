import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const RouletteTestSetupModule = buildModule("RouletteTestSetup", (m) => {
  // Deploy Mock LINK Token
  const mockLinkToken = m.contract("MockLinkToken");

  // Deploy VRF Coordinator Mock
  const vrfCoordinatorMock = m.contract("VRFCoordinatorV2_5Mock", [
    100000000000000000n, // 0.1 LINK base fee
    1000000000n, // 0.000001 LINK per gas
  ]);

  // Deploy Mock Automation contracts
  const mockAutomationRegistry = m.contract("MockAutomationRegistry");

  // Deploy BRB Token
  const brbToken = m.contract("BRB");

  // Get test addresses
  const admin = m.getAccount(0);
  const player1 = m.getAccount(1);
  const player2 = m.getAccount(2);

  // VRF settings for testing
  const gamePeriod = 60; // 60 seconds
  const keyHash2Gwei = "0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805";
  const keyHash30Gwei = "0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15";
  const keyHash150Gwei = "0xff8dedfbfa60af186cf3c830acbc32c05aae823045ae5ea7da1e45fbfaba4f92";
  const subscriptionId = 1n;
  const callbackGasLimit = 100000;
  const numWords = 1;
  const safeBlockConfirmation = 3;

  // Deploy StakedBRB implementation
  const stakedBRBImpl = m.contract("StakedBRB", [brbToken, "TEMP_ADDRESS"]);

  // Deploy StakedBRB proxy
  const stakedBRBProxy = m.contract("ERC1967Proxy", [
    stakedBRBImpl,
    "0x", // Empty initialization data
  ]);

  // Cast proxy to StakedBRB interface
  const stakedBRB = m.contractAt("StakedBRB", stakedBRBProxy);

  // Deploy RouletteClean implementation  
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
    stakedBRB, // Use proxy address
  ]);

  // Deploy RouletteClean proxy
  const rouletteProxy = m.contract("ERC1967Proxy", [
    rouletteImpl,
    "0x", // Empty initialization data
  ]);

  // Cast proxy to RouletteClean interface
  const roulette = m.contractAt("RouletteClean", rouletteProxy);

  return {
    mockLinkToken,
    vrfCoordinatorMock,
    mockAutomationRegistry,
    brbToken,
    stakedBRB,
    roulette,
    admin,
    player1,
    player2,
  };
});

export default RouletteTestSetupModule;
