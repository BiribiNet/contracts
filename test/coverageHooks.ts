import { network } from "hardhat";

/** Reset base fee around tests that tweak `tx.gasprice` (VRF key-hash tiers). */
async function resetBaseFee() {
    if (process.env.SOLIDITY_COVERAGE === "true") {
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    }
}

beforeEach(resetBaseFee);
afterEach(resetBaseFee);
