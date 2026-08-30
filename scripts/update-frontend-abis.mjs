/**
 * Regenerate the frontend's hand-copied SideBet ABI from the compiled artifact.
 *
 * WHY THIS EXISTS: `frontend/lib/abi/side-bet.ts` is a standalone copy, because SideBet is not in
 * the wagmi include list and `yarn compile` therefore never touches it. Kept by hand, it drifted:
 * it still described the pre-security-fix contract, so `RoundOutcomeAlreadyKnown` — the revert a
 * player hits whenever their bet is mined after the round's VRF lands — decoded to a raw selector
 * with no message. The frontend cannot catch that on its own; it has no access to these artifacts.
 *
 * Also tops up `frontend/lib/abi/merged-errors.json` with any SideBet error it is missing, since
 * that errors-only bundle is what `lib/contract-errors.ts` decodes reverts against.
 *
 * Usage (from contracts repo root):
 *   yarn update:frontend:abis
 *   SKIP_COMPILE=1 yarn update:frontend:abis
 *   yarn update:frontend:abis --check     # fail if regeneration would change anything
 *
 * Env:
 *   FRONTEND_DIR — override frontend folder (default: ../frontend)
 *   SKIP_COMPILE — skip `yarn hardhat compile`
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const frontendDir = process.env.FRONTEND_DIR
  ? path.resolve(repoRoot, process.env.FRONTEND_DIR)
  : path.resolve(repoRoot, "..", "frontend");

const checkOnly = process.argv.includes("--check");

const sideBetArtifact = path.join(repoRoot, "artifacts", "contracts", "SideBet.sol", "SideBet.json");
const sideBetAbiFile = path.join(frontendDir, "lib", "abi", "side-bet.ts");
const mergedErrorsFile = path.join(frontendDir, "lib", "abi", "merged-errors.json");

const HEADER = `// lib/abi/side-bet.ts
// SideBet (BRBGAME) ABI — standalone copy of the compiled artifact
// (contracts/SideBet.sol). SideBet is NOT in the contracts repo's wagmi
// include list, so this file must NOT be a re-export of generated.ts:
// a \`yarn compile\` in the contracts repo regenerates generated.ts without
// sideBetAbi.
//
// Regenerate with \`yarn update:frontend:abis\` in the contracts repo after any
// SideBet interface change — do not hand-edit. This file silently drifted once
// (it still described the pre-security-fix contract, so the anti-frontrun revert
// \`RoundOutcomeAlreadyKnown\` could not be decoded for players).

export const sideBetAbi = `;

if (!process.env.SKIP_COMPILE && !checkOnly) {
  const compiled = spawnSync("yarn", ["hardhat", "compile"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (compiled.error) {
    console.error(compiled.error);
    process.exit(1);
  }
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
}

if (!fs.existsSync(sideBetArtifact)) {
  console.error(`[update-frontend-abis] missing artifact: ${sideBetArtifact} — run \`yarn compile\`.`);
  process.exit(1);
}
if (!fs.existsSync(sideBetAbiFile)) {
  console.error(`[update-frontend-abis] missing frontend file: ${sideBetAbiFile}`);
  process.exit(1);
}

const { abi } = JSON.parse(fs.readFileSync(sideBetArtifact, "utf8"));
if (!Array.isArray(abi)) {
  console.error("[update-frontend-abis] SideBet artifact has no abi array");
  process.exit(1);
}

let changed = false;

// ── side-bet.ts ───────────────────────────────────────────────────────────────
const nextAbiFile = `${HEADER}${JSON.stringify(abi, null, 2)} as const;\n`;
if (fs.readFileSync(sideBetAbiFile, "utf8") !== nextAbiFile) {
  changed = true;
  if (!checkOnly) fs.writeFileSync(sideBetAbiFile, nextAbiFile);
  console.log(`[update-frontend-abis] ${checkOnly ? "STALE" : "wrote"} ${path.relative(repoRoot, sideBetAbiFile)} (${abi.length} fragments)`);
} else {
  console.log("[update-frontend-abis] side-bet.ts already up to date");
}

// ── merged-errors.json ────────────────────────────────────────────────────────
// Errors-only bundle shared by every contract, so append rather than rewrite: anything
// already there belongs to another contract and must be left alone.
if (fs.existsSync(mergedErrorsFile)) {
  const merged = JSON.parse(fs.readFileSync(mergedErrorsFile, "utf8"));
  const known = new Set(merged.filter((f) => f.type === "error").map((f) => f.name));
  const missing = abi
    .filter((f) => f.type === "error" && !known.has(f.name))
    .map((f) => ({ type: "error", name: f.name, inputs: f.inputs ?? [] }));

  if (missing.length > 0) {
    changed = true;
    if (!checkOnly) {
      fs.writeFileSync(mergedErrorsFile, `${JSON.stringify([...merged, ...missing], null, 2)}\n`);
    }
    console.log(
      `[update-frontend-abis] ${checkOnly ? "MISSING from" : "added to"} merged-errors.json: ${missing
        .map((m) => m.name)
        .join(", ")}`,
    );
    if (!checkOnly) {
      console.log(
        "[update-frontend-abis] NOTE: map any new player-facing error in " +
          "frontend/lib/contract-errors.ts (ERROR_TRANSLATION_KEYS) and add its message to messages/*.json.",
      );
    }
  } else {
    console.log("[update-frontend-abis] merged-errors.json already covers every SideBet error");
  }
} else {
  console.warn(`[update-frontend-abis] skip merged-errors: ${mergedErrorsFile} not found`);
}

if (checkOnly && changed) {
  console.error("[update-frontend-abis] frontend ABIs are stale — run `yarn update:frontend:abis`.");
  process.exit(1);
}
