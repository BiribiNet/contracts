import { viem } from "hardhat";
import { parseAbi, parseEventLogs, parseEther } from "viem";
import { readFileSync } from "fs";
async function main() {
  const report = JSON.parse(readFileSync("reports/swarm/live-sepolia-2026-10-15-dai.json", "utf8"));
  const pc = await viem.getPublicClient();
  const [w] = await viem.getWalletClients();
  const dai = report.dai as `0x${string}`;
  const bank = report.bank as `0x${string}`;
  const transferAbi = parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const fromBlock = (await pc.getTransactionReceipt({ hash: report.betHashes[0] })).blockNumber;
  const toBlock = (await pc.getTransactionReceipt({ hash: report.fundingTx })).blockNumber;
  const logs = await pc.getLogs({
    address: dai,
    fromBlock,
    toBlock,
    args: {},
  } as any);
  // Filter transfers involving admin or bank
  const parsed = parseEventLogs({ abi: transferAbi, logs, strict: false });
  let toAdmin = 0n, fromAdmin = 0n, toBank = 0n;
  for (const log of parsed) {
    if (log.eventName !== "Transfer") continue;
    const a: any = log.args;
    if (a.to?.toLowerCase() === w.account.address.toLowerCase()) toAdmin += BigInt(a.value);
    if (a.from?.toLowerCase() === w.account.address.toLowerCase()) fromAdmin += BigInt(a.value);
  }
  console.log(JSON.stringify({
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    toAdmin: toAdmin.toString(),
    fromAdmin: fromAdmin.toString(),
    netAdmin: (toAdmin - fromAdmin).toString(),
    expectedPayout: (parseEther("36") * BigInt(report.tickets)).toString(),
    expectedStake: (parseEther("37") * BigInt(report.tickets)).toString(),
    expectedNet: (-parseEther("1") * BigInt(report.tickets)).toString(),
  }, null, 2));
}
main();
