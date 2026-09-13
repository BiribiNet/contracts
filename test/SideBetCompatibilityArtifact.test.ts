import { artifacts } from "hardhat";
import { expect } from "chai";
import { assertSideBetCompatibility } from "../scripts/utils/assertSideBetCompatibility";

describe("SideBet deployment compatibility gate", () => {
    it("accepts the tested candidate within the deployed code size limit", async () => {
        expect(() => assertSideBetCompatibility(artifact)).not.to.throw();
    });
    let artifact: Awaited<ReturnType<typeof artifacts.readArtifact>>;
    before(async () => { artifact = await artifacts.readArtifact("SideBet"); });
    it("rejects a candidate missing the deployed settlement selector", () => {
        expect(() => assertSideBetCompatibility({...artifact, abi: artifact.abi.filter(item => item.name !== "settleBatch")})).to.throw("settlement selector");
    });
    it("rejects an oversized implementation even if local Hardhat allows it", () => {
        expect(() => assertSideBetCompatibility({...artifact, deployedBytecode: "0x" + "00".repeat(24577)})).to.throw("deployment limits");
    });
    it("rejects the ambiguous preview format that caused the Sepolia failure", () => {
        const abi = artifact.abi.map(item => item.name === "previewSettleBundle"
            ? {...item, outputs:[{type:"tuple[]", components:[{},{},{},{}]}]} : item);
        expect(() => assertSideBetCompatibility({...artifact, abi})).to.throw("previewSettleBundle return tuple");
    });
});
