import { viem } from "hardhat";
async function main() {
  const d = Number(process.env.NEW_ROUND_DURATION || "60");
  const engine = await viem.getContractAt("RouletteEngine", "0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1");
  const before = await engine.read.ROUND_DURATION();
  const [w] = await viem.getWalletClients();
  const hash = await engine.write.setRoundDuration([d], { account: w.account });
  const pc = await viem.getPublicClient();
  const receipt = await pc.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ before: before.toString(), after: (await engine.read.ROUND_DURATION()).toString(), tx: hash, status: receipt.status }));
}
main();
