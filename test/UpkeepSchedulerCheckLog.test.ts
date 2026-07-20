import { viem } from "hardhat";

import { expect } from "chai";
import { encodeFunctionData, keccak256, toBytes, zeroAddress } from "viem";

import { deployProtocolStack } from "./helpers/deployProtocolStack";

const VRF_RESULT_TOPIC = keccak256(toBytes("VRFResult(uint64,uint8,uint8)"));
const PAYOUT_PROGRESS_TOPIC = keccak256(toBytes("PayoutProgress(uint64,uint32,uint256,uint256,uint256)"));

function emptyLog(source: `0x${string}`, topic0: `0x${string}`) {
    return {
        index: 0n,
        timestamp: 0n,
        txHash: `0x${"00".repeat(32)}` as `0x${string}`,
        blockNumber: 1n,
        blockHash: `0x${"00".repeat(32)}` as `0x${string}`,
        source,
        topics: [topic0] as readonly `0x${string}`[],
        data: "0x" as `0x${string}`,
    };
}

describe("UpkeepScheduler checkLog", function () {
    it("rejects logs from non-engine sources", async function () {
        const { scheduler } = await deployProtocolStack();
        const [needed] = await scheduler.read.checkLog([emptyLog(zeroAddress, VRF_RESULT_TOPIC), "0x"]);
        expect(needed).to.equal(false);
    });

    it("rejects engine logs with unknown topics", async function () {
        const { scheduler, engine } = await deployProtocolStack();
        const unknownTopic = keccak256(toBytes("UnknownEvent()"));
        const [needed] = await scheduler.read.checkLog([emptyLog(engine.address, unknownTopic), "0x"]);
        expect(needed).to.equal(false);
    });

    it("accepts VRFResult from engine and delegates to checkUpkeep", async function () {
        const { scheduler, engine } = await deployProtocolStack();
        const [upkeepFromLog] = await scheduler.read.checkLog([
            emptyLog(engine.address, VRF_RESULT_TOPIC),
            "0x",
        ]);
        const [upkeepDirect] = await scheduler.read.checkUpkeep(["0x"]);
        expect(upkeepFromLog).to.equal(upkeepDirect);
    });

    it("accepts PayoutProgress from engine and delegates to checkUpkeep", async function () {
        const { scheduler, engine } = await deployProtocolStack();
        const checkData = "0x" as `0x${string}`;
        const [upkeepFromLog] = await scheduler.read.checkLog([
            emptyLog(engine.address, PAYOUT_PROGRESS_TOPIC),
            checkData,
        ]);
        const [upkeepDirect] = await scheduler.read.checkUpkeep([checkData]);
        expect(upkeepFromLog).to.equal(upkeepDirect);
    });

    it("exposes checkLog on the scheduler ABI for CRE simulation", async function () {
        const { scheduler, engine } = await deployProtocolStack();
        const data = encodeFunctionData({
            abi: scheduler.abi,
            functionName: "checkLog",
            args: [emptyLog(engine.address, VRF_RESULT_TOPIC), "0x"],
        });
        expect(data.startsWith("0x")).to.equal(true);
    });
});
