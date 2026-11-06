import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ERROR_SOURCES, SIDE_BET_REFUSAL, updateFrontendAbis } from "./update-frontend-abis.mjs";

const SNAPSHOT = "// frozen Arbitrum Sepolia snapshot\nexport const sideBetAbi = [] as const;\n";
const error = (name, ...types) => ({ type: "error", name, inputs: types.map((type, index) => ({ name: `a${index}`, type })) });

/** Temporary contracts repo (artifacts only) + frontend tree; never touches the real frontend. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-abis-"));
  const repoRoot = path.join(dir, "contracts");
  const frontendDir = path.join(dir, "frontend");
  const abis = {
    "SideBet.sol/SideBet.json": [{ type: "function", name: "placeBet", inputs: [], outputs: [] }, error("SideBetsDisabled")],
    "RouletteEngine.sol/RouletteEngine.json": [error("MaskBetsDisabled"), error("MaskLegCapExceeded"), error("InvalidBetNumber")],
    "BankVault4626.sol/BankVault4626.json": [error("OnlyEngine")],
    "libraries/RouletteMaskBetLib.sol/RouletteMaskBetLib.json": [error("MaskLegBelowMinBet"), error("PreviousOutcomeMismatch")],
    "libraries/RouletteLiabilityMathLib.sol/RouletteLiabilityMathLib.json": [error("MaskLiabilityCapExceeded"), error("OnlyEngine")],
  };
  assert.deepEqual(Object.keys(abis).sort(), [...ERROR_SOURCES].sort());
  for (const [file, abi] of Object.entries(abis)) {
    const full = path.join(repoRoot, "artifacts", "contracts", file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify({ abi }));
  }
  fs.mkdirSync(path.join(frontendDir, "lib", "abi"), { recursive: true });
  fs.writeFileSync(path.join(frontendDir, "lib", "abi", "side-bet.ts"), SNAPSHOT);
  // Same name, different signature: a distinct selector, so it must be added rather than skipped.
  fs.writeFileSync(path.join(frontendDir, "lib", "abi", "merged-errors.json"),
    JSON.stringify([error("InvalidBetNumber", "uint256"), error("OnlyEngine")]));
  const read = (name) => fs.readFileSync(path.join(frontendDir, "lib", "abi", name), "utf8");
  return { repoRoot, frontendDir, read, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("by default the Sepolia snapshot side-bet.ts is never written and the refusal explains the mainnet path", () => {
  const f = fixture();
  try {
    const lines = [];
    const result = updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, log: (line) => lines.push(line) });
    assert.equal(f.read("side-bet.ts"), SNAPSHOT);
    assert.equal(result.sideBetWritten, false);
    assert.match(SIDE_BET_REFUSAL, /arbitrum-one-abi\.json/);
    assert.match(SIDE_BET_REFUSAL, /generate-mainnet-abi\.mjs/);
    assert.match(SIDE_BET_REFUSAL, /--sepolia-snapshot/);
    assert.ok(lines.some((line) => line.includes(SIDE_BET_REFUSAL)));
  } finally { f.cleanup(); }
});

test("merged-errors.json gains every missing engine, vault, mask-library and SideBet error, append-only", () => {
  const f = fixture();
  try {
    const result = updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, log: () => {} });
    const merged = JSON.parse(f.read("merged-errors.json"));
    assert.deepEqual(merged.slice(0, 2), [error("InvalidBetNumber", "uint256"), error("OnlyEngine")]);
    assert.deepEqual(merged.slice(2).map((fragment) => fragment.name), [
      "SideBetsDisabled", "MaskBetsDisabled", "MaskLegCapExceeded", "InvalidBetNumber",
      "MaskLegBelowMinBet", "PreviousOutcomeMismatch", "MaskLiabilityCapExceeded",
    ]);
    assert.equal(result.addedErrors.length, 7);
    assert.ok(merged.every((fragment) => fragment.type === "error"), "errors-only bundle");
    // Idempotent: a second run adds nothing.
    assert.equal(updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, log: () => {} }).addedErrors.length, 0);
  } finally { f.cleanup(); }
});

test("--sepolia-snapshot rewrites side-bet.ts from the SideBet artifact", () => {
  const f = fixture();
  try {
    const result = updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, sepoliaSnapshot: true, log: () => {} });
    assert.equal(result.sideBetWritten, true);
    assert.match(f.read("side-bet.ts"), /frozen Arbitrum Sepolia snapshot/);
    assert.match(f.read("side-bet.ts"), /"name": "placeBet"/);
  } finally { f.cleanup(); }
});

test("--check writes nothing and reports what is missing", () => {
  const f = fixture();
  try {
    const before = f.read("merged-errors.json");
    const result = updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, checkOnly: true, sepoliaSnapshot: true, log: () => {} });
    assert.equal(f.read("merged-errors.json"), before);
    assert.equal(f.read("side-bet.ts"), SNAPSHOT);
    assert.equal(result.sideBetStale, true);
    assert.ok(result.addedErrors.length > 0);
  } finally { f.cleanup(); }
});

test("a missing artifact fails loudly instead of silently skipping errors", () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.repoRoot, "artifacts", "contracts", ERROR_SOURCES[3]));
    assert.throws(() => updateFrontendAbis({ repoRoot: f.repoRoot, frontendDir: f.frontendDir, log: () => {} }), /missing artifact/);
  } finally { f.cleanup(); }
});
