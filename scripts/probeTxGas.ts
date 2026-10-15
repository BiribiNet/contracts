import { viem } from "hardhat";
async function main() {
  const hashes = (process.env.TX_HASHES || "").split(",").filter(Boolean) as `0x${string}`[];
  const pc = await viem.getPublicClient();
  const out = [];
  for (const hash of hashes) {
    const r = await pc.getTransactionReceipt({ hash });
    out.push({ hash, status: r.status, gasUsed: r.gasUsed.toString(), block: r.blockNumber.toString() });
  }
  console.log(JSON.stringify(out, null, 2));
}
main();
