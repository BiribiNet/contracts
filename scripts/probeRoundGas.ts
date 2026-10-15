import { viem } from "hardhat";
import { parseAbi, parseEventLogs } from "viem";
async function main() {
  const round = BigInt(process.env.PROBE_ROUND || "2527");
  const engineAddr = "0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1" as const;
  const pc = await viem.getPublicClient();
  const from = BigInt(process.env.FROM_BLOCK!);
  const to = BigInt(process.env.TO_BLOCK!);
  const vrfAbi = parseAbi(["event VRFResult(uint64 roundId, uint8 winningNumber, uint8 jackpotNumber)"]);
  const logs = await pc.getLogs({ address: engineAddr, fromBlock: from, toBlock: to });
  const parsed = parseEventLogs({ abi: vrfAbi, logs, strict: false });
  const hits = [] as any[];
  for (const log of parsed) {
    if (log.eventName !== "VRFResult") continue;
    const args: any = log.args;
    if (BigInt(args.roundId) !== round) continue;
    const receipt = await pc.getTransactionReceipt({ hash: log.transactionHash });
    hits.push({ tx: log.transactionHash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() });
  }
  console.log(JSON.stringify({ from: from.toString(), to: to.toString(), hits }, null, 2));
}
main();
