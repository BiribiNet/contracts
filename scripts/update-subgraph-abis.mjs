/**
 * Copy ABIs from Hardhat artifacts into ../subgraph/abis and build MergedEvents.json
 * for Goldsky _gs_log_decode (same pattern as tcg-vault).
 *
 * Usage (from contracts repo root):
 *   yarn update:subgraph:abis
 *   SKIP_COMPILE=1 yarn update:subgraph:abis
 *
 * Env:
 *   SUBGRAPH_ABIS_DIR — override subgraph abis folder (default: ../subgraph/abis)
 *   SKIP_COMPILE      — skip `yarn hardhat compile`
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const destDir = process.env.SUBGRAPH_ABIS_DIR
  ? path.resolve(repoRoot, process.env.SUBGRAPH_ABIS_DIR)
  : path.resolve(repoRoot, "..", "subgraph", "abis");

const artifactsRoot = path.join(repoRoot, "artifacts", "contracts");

function artifactJsonPath(solName) {
  if (solName === "AutomationReceiver") {
    return path.join(artifactsRoot, "chainlink", "cre", `${solName}.sol`, `${solName}.json`);
  }
  return path.join(artifactsRoot, `${solName}.sol`, `${solName}.json`);
}

/** Subgraph data-source file names → Solidity artifact base name */
const ABI_COPY_MAP = [
  ["AssetToken.json", "MockUSDC"],
  ["Game.json", "RouletteEngine"],
  ["JackpotTreasury.json", "JackpotTreasury"],
  ["BankVault4626.json", "BankVault4626"],
  ["BRBJackpotFunder.json", "BRBJackpotFunder"],
  ["SideBet.json", "SideBet"],
  ["UpkeepScheduler.json", "UpkeepScheduler"],
  ["CreExecutionAuthority.json", "CreExecutionAuthority"],
  ["AutomationReceiver.json", "AutomationReceiver"],
];

/** Contracts whose events are merged for Goldsky (deduped). */
/** Registry omitted: market catalog is RouletteEngine.MarketRegistered only (no MarketCreated). */
const MERGE_EVENT_SOURCES = [
  "MockUSDC",
  "RouletteEngine",
  "JackpotTreasury",
  "BankVault4626",
  "BRBJackpotFunder",
  "SideBet",
  "UpkeepScheduler",
  "CreExecutionAuthority",
  "AutomationReceiver",
];

/** Legacy registry event; market catalog uses RouletteEngine.MarketRegistered only. */
const EXCLUDED_MERGE_EVENT_NAMES = new Set(["MarketCreated"]);

if (!process.env.SKIP_COMPILE) {
  const r = spawnSync("yarn", ["hardhat", "compile"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

fs.mkdirSync(destDir, { recursive: true });

function eventKey(item) {
  const inputs = Array.isArray(item.inputs)
    ? item.inputs.map((i) => ({
        type: i.type,
        indexed: Boolean(i.indexed),
        name: i.name ?? "",
        components: i.components ?? [],
      }))
    : [];
  return JSON.stringify({
    type: item.type,
    name: item.name ?? "",
    anonymous: Boolean(item.anonymous),
    inputs,
  });
}

const seenEventKeys = new Set();
const mergedEvents = [];

for (const solName of MERGE_EVENT_SOURCES) {
  const artifactPath = artifactJsonPath(solName);
  if (!fs.existsSync(artifactPath)) {
    console.warn(`[update-subgraph-abis] skip merge ${solName}: missing ${artifactPath}`);
    continue;
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch (e) {
    console.warn(`[update-subgraph-abis] skip merge ${solName}:`, e);
    continue;
  }
  if (!Array.isArray(artifact.abi)) continue;
  for (const item of artifact.abi) {
    if (!item || item.type !== "event") continue;
    if (EXCLUDED_MERGE_EVENT_NAMES.has(item.name)) {
      continue;
    }
    const key = eventKey(item);
    if (seenEventKeys.has(key)) continue;
    seenEventKeys.add(key);
    mergedEvents.push(item);
  }
}

for (const [outFile, solName] of ABI_COPY_MAP) {
  const artifactPath = artifactJsonPath(solName);
  if (!fs.existsSync(artifactPath)) {
    console.warn(`[update-subgraph-abis] skip copy ${outFile}: missing ${artifactPath}`);
    continue;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!Array.isArray(artifact.abi)) {
    console.warn(`[update-subgraph-abis] skip copy ${outFile}: no abi`);
    continue;
  }
  const outPath = path.join(destDir, outFile);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact.abi, null, 2)}\n`, "utf8");
  console.log(`[update-subgraph-abis] wrote ${outPath}`);
}

const mergedOutPath = path.join(destDir, "MergedEvents.json");
fs.writeFileSync(mergedOutPath, `${JSON.stringify(mergedEvents, null, 2)}\n`, "utf8");
console.log(
  `[update-subgraph-abis] wrote ${mergedOutPath} (${mergedEvents.length} unique event(s))`
);
console.log(`[update-subgraph-abis] done → ${destDir}`);
