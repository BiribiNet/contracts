import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const { abi } = JSON.parse(readFileSync(new URL("artifacts/contracts/TipJar.sol/TipJar.json", root), "utf8"));
const files = [
  [new URL("../frontend/lib/abi/tip-jar.ts", root), `// Generated from contracts/TipJar.sol by scripts/update-tip-abis.mjs.\nexport const tipJarAbi = ${JSON.stringify(abi, null, 2)} as const;\n`],
  [new URL("../subgraph/abis/TipJar.json", root), JSON.stringify(abi, null, 2) + "\n"],
];
for (const [file, content] of files) {
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== content) throw new Error(`Stale ABI: ${fileURLToPath(file)}`);
  } else writeFileSync(file, content);
}
