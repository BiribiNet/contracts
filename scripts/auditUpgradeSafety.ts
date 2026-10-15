/** Offline validation and ephemeral local deployments only. Never run on a public network. */
import hre, { artifacts, ethers } from "hardhat";
import { assertUpgradeSafe, getVersion } from "@openzeppelin/upgrades-core";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "node:path";

async function main() {
    if (hre.network.name !== "hardhat") throw new Error("Audit requires ephemeral hardhat network");
    const rows = [];
    const contracts = ["RouletteEngine", "SideBet", "BankVault4626", "MarketRegistry", "JackpotTreasury", "BRBJackpotFunder", "UpkeepScheduler", "AutomationReceiver", "CreExecutionAuthority", "ProtocolTimelock", "BRBToken", "BRBReferal", "LPVestingLock", "TipJar", "SideBetChallengeEvaluator", "RouletteLib", "RouletteBetLib", "JackpotBatchLib", "RouletteBetCodecLib", "RoulettePayoutMulLib", "RouletteLiabilityMathLib", "RoulettePayoutSweepLib", "RouletteJackpotCollectLib", "RouletteExposureLib", "RouletteUpkeepScanLib"];
    for (const name of contracts) {
        const a = await artifacts.readArtifact(name);
        rows.push({ contract: name, runtimeBytes: (a.deployedBytecode.length - 2) / 2,
            eip170Limit: 24576, runtimeFits: (a.deployedBytecode.length - 2) / 2 <= 24576,
            initcodeBytesWithoutConstructorArgs: (a.bytecode.length - 2) / 2 });
    }
    const validations = [];
    for (const [name, kind] of [["RouletteEngine", "uups"], ["SideBet", "uups"], ["BankVault4626", "beacon"]] as const) {
        const a = await artifacts.readArtifact(name);
        const unsafeAllow = name === "RouletteEngine" ? ["constructor", "state-variable-immutable", "external-library-linking"] as const : [];
        try {
            // Validate the exact artifact version directly. The installed plugin's
            // getUnlinkedBytecode scans unrelated cached link positions and can
            // corrupt shorter unlinked candidates before validation even starts.
            const cache = JSON.parse(readFileSync(join(__dirname, "../cache/validations.json"), "utf8"));
            let strictError: string | undefined;
            try { assertUpgradeSafe(cache, getVersion(a.bytecode), { kind }); } catch (e) { strictError = String(e); }
            assertUpgradeSafe(cache, getVersion(a.bytecode), { kind, unsafeAllow: [...unsafeAllow] });
            validations.push({ contract: name, valid: true, exceptions: unsafeAllow,
                strictWithoutExceptions: !strictError, strictError,
                limitation: name === "RouletteEngine" ? "Library namespace requires auditStorageLayouts.py; immutable values and linked bytecode need separate review" : "Does not prove application state migration or lock standalone implementation" });
        } catch (e) {
            validations.push({ contract: name, valid: false, error: String(e) });
        }
    }
    const roots = [];
    for (const id of ["biribi.storage.RouletteEngine", "biribi.storage.SideBet", "biribi.storage.BankVault4626"]) {
        const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(id))) - 1n;
        const root = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner]))) & ~255n;
        roots.push({ id, computedErc7201Root: ethers.toBeHex(root, 32) });
    }
    const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        nodeVersion: process.version, scope: "Offline candidate validation, not mainnet authorization", contracts: rows, validations, namespaces: roots };
    const output = join(__dirname, "../deployments/mainnet-build-2026-10-15.json");
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    if (rows.some(row => !row.runtimeFits) || validations.some(row => !row.valid)) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
