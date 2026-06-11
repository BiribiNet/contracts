import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import hre from "hardhat";
import { keccak256 } from "viem";

const PAIR_FQN = "contracts/vendor/uniswap-v2-core/UniswapV2Pair.sol:UniswapV2Pair" as const;
const LIBRARY_PATH = join(
    __dirname,
    "..",
    "contracts/vendor/uniswap-v2-periphery/libraries/UniswapV2Library.sol",
);
const GENERATED_JSON = join(__dirname, "..", "test/helpers/uniswapV2PairInitCodeHash.generated.json");

const OLD_HASHES = [
    "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
    "6480cbf8cd4d6d78ca063f11e1e4931cc0c44670ad6d0bfdcce2307b75e944bf",
    "c02216f26ea942aba32dffc9b56cf12d467d76c1f46ffefb5521490e56f35db9",
] as const;

async function readPairInitCodeHash(): Promise<`0x${string}`> {
    const artifact = await hre.artifacts.readArtifact(PAIR_FQN);
    return keccak256(artifact.bytecode as `0x${string}`);
}

function patchLibrary(hashNoPrefix: string): boolean {
    let lib = readFileSync(LIBRARY_PATH, "utf8");
    const hexLiteral = `hex'${hashNoPrefix}'`;
    const pattern = /hex'[0-9a-fA-F]{64}' \/\/ init code hash \(vendored pair in this repo\)/;
    if (!pattern.test(lib)) {
        throw new Error(`Could not find init code hash slot in ${LIBRARY_PATH}`);
    }
    const next = lib.replace(
        pattern,
        `${hexLiteral} // init code hash (vendored pair in this repo)`,
    );
    if (next === lib) return false;
    writeFileSync(LIBRARY_PATH, next, "utf8");
    return true;
}

async function main() {
    const hash = await readPairInitCodeHash();
    const bare = hash.slice(2).toLowerCase();

    writeFileSync(
        GENERATED_JSON,
        `${JSON.stringify({ initCodeHash: hash, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
    );

    const lib = readFileSync(LIBRARY_PATH, "utf8");
    const currentMatch = lib.match(/hex'([0-9a-fA-F]{64})' \/\/ init code hash \(vendored pair in this repo\)/);
    const current = currentMatch?.[1]?.toLowerCase();

    if (current === bare) {
        console.log(`UniswapV2Library init code hash already synced: ${hash}`);
        return;
    }

    if (current && !OLD_HASHES.includes(current as (typeof OLD_HASHES)[number])) {
        console.warn(`Replacing unknown library hash 0x${current} → ${hash}`);
    }

    patchLibrary(bare);
    console.log(`Updated UniswapV2Library init code hash → ${hash}`);
    console.log(`Wrote ${GENERATED_JSON}`);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
