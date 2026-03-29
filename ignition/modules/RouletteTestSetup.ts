import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const RouletteTestSetupModule = buildModule("RouletteTestSetup", (m) => {
  const mockLinkToken = m.contract("MockLinkToken");

  const vrfCoordinatorMock = m.contract("VRFCoordinatorV2_5Mock", [
    100000000000000000n,
    1000000000n,
    4_000_000_000_000_000n,
  ]);

  const mockAutomationRegistry = m.contract("MockAutomationRegistry");

  const brbToken = m.contract("BRB");

  const rouletteLib = m.contract("RouletteLib");

  const gamePeriod = 60;
  const keyHash2Gwei = "0x9fe0eebf5e446e3c998ec9bb19951541aee00bb90ea201ae456421a2ded86805";
  const keyHash30Gwei = "0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15";
  const keyHash150Gwei = "0xff8dedfbfa60af186cf3c830acbc32c05aae823045ae5ea7da1e45fbfaba4f92";
  const subscriptionId = 1n;
  const callbackGasLimit = 100000;
  const numWords = 1;
  const safeBlockConfirmation = 3;

  const placeholder = "0x0000000000000000000000000000000000000001";

  const stakedBRBImpl = m.contract("StakedBRB", [
    brbToken,
    placeholder,
    brbToken,
    placeholder,
    mockAutomationRegistry,
    gamePeriod,
  ]);

  const rouletteImpl = m.contract(
    "RouletteClean",
    [
      {
        vrfCoordinator: vrfCoordinatorMock,
        keyHash2Gwei,
        keyHash30Gwei,
        keyHash150Gwei,
        subscriptionId,
        callbackGasLimit,
        numWords,
        safeBlockConfirmation,
        stakedBRBContract: placeholder,
        linkToken: mockLinkToken,
        jackpotContract: placeholder,
        brbToken,
        upkeepManager: mockAutomationRegistry,
      },
    ],
    {
      libraries: {
        RouletteLib: rouletteLib,
      },
    },
  );

  const stakedBRBProxy = m.contract("ERC1967Proxy", [stakedBRBImpl, "0x"], {
    id: "StakedBRBERC1967Proxy",
  });

  const rouletteProxy = m.contract("ERC1967Proxy", [rouletteImpl, "0x"], {
    id: "RouletteCleanERC1967Proxy",
  });

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
