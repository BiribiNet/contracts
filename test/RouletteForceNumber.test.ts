import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { encodeAbiParameters, parseEther, parseEventLogs, zeroAddress } from "viem";
import { useDeployWithCreateFixture } from "./fixtures/deployWithCreateFixture";

describe("RouletteForceNumber", function () {
  it("Should force winning number and jackpot number overriding VRF result", async function () {
    const { rouletteProxy, stakedBrbProxy, brb, vrfCoordinator } = await useDeployWithCreateFixture();
    const [admin, player1] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // 1. Setup: Stake and Bet to ensure round is active
    const stakeAmount = parseEther("1000");
    await brb.write.approve([stakedBrbProxy.address, stakeAmount], { account: player1.account });
    await stakedBrbProxy.write.deposit([stakeAmount, player1.account.address, 0n], { account: player1.account });

    const betAmount = parseEther("0.1");
    // Bet on number 7
    const betData = encodeAbiParameters(
      [{ type: "tuple", components: [
        { type: "uint256[]", name: "amounts" },
        { type: "uint256[]", name: "betTypes" },
        { type: "uint256[]", name: "numbers" }
      ]}],
      [{ amounts: [betAmount], betTypes: [1n], numbers: [7n] }]
    );
    await brb.write.bet([stakedBrbProxy.address, betAmount, betData, zeroAddress], { account: player1.account });

    // 2. Force the number
    const forcedWinningNumber = 7n;
    const forcedJackpotNumber = 7n;
    await rouletteProxy.write.testForceNumber([forcedWinningNumber, forcedJackpotNumber]);

    // 3. Advance time to enable upkeep
    const timeUntilNextRound = await rouletteProxy.read.getSecondsFromNextUpkeepWindow();
    if (timeUntilNextRound > 0n) await time.increase(timeUntilNextRound);

    // 4. Trigger Upkeep (VRF Request)
    const [needsExecutionVRF, performDataVRF] = await rouletteProxy.read.checkUpkeep(["0x"]);
    expect(needsExecutionVRF).to.be.true; // Should need upkeep now

    const txVRF = await rouletteProxy.write.performUpkeep([performDataVRF]);
    
    // Get Request ID from logs
    const receiptVRF = await publicClient.waitForTransactionReceipt({ hash: txVRF });
    const logsVRF = parseEventLogs({
      abi: rouletteProxy.abi,
      eventName: 'RoundStarted',
      logs: receiptVRF.logs,
    });
    const requestId = logsVRF[0].args.requestId;
    
    // Get the round that was just finished/resolved (it's the roundId from the event - 1, or simpler: clean currentRound is new round, so check previous)
    // Actually fulfillRandomWords uses requestIdToRound to resolve the associated round.
    // The logsVRF args are: newRoundId, newLastRoundStartTimestamp, requestId.
    // So the requestId is associated with the *previous* round (the one we just bet on).
    // Let's verify which round that was.
    // Before performUpkeep, we were in round 1 (usually, if fresh deploy). 
    // After performUpkeep, we are in round 2.
    // requestId is tied to round 1.

    // 5. Fulfill VRF with DIFFERENT numbers
    const vrfWinningNumber = 20n;
    const vrfJackpotNumber = 20n;
    // vrfCoordinator mock likely takes [requestId, consumerAddress, randomWords]
    // randomWords is array. logic: winningNumber = randomWords[0] % 37, jackpotNumber = randomWords[1] % 37
    // So passing [20, 20] works.
    await vrfCoordinator.write.fulfillRandomWordsWithOverride([requestId, rouletteProxy.address, [vrfWinningNumber, vrfJackpotNumber]]);

    // 6. Verify Result matches FORCED numbers, not VRF numbers
    // The event log RoundStarted gives us the *new* round ID. The resolved round is newRoundId - 1.
    const newRoundId = logsVRF[0].args.roundId;
    const resolvedRoundId = newRoundId - 1n;

    const roundResult = await rouletteProxy.read.getRoundResult([resolvedRoundId]);
    console.log(roundResult)
    expect(roundResult.set).to.be.true;
    expect(roundResult.winningNumber).to.equal(forcedWinningNumber);
    expect(roundResult.jackpotNumber).to.equal(forcedJackpotNumber);
    expect(roundResult.winningNumber).to.not.equal(vrfWinningNumber);
    expect(roundResult.jackpotNumber).to.not.equal(vrfJackpotNumber);
  });
});
