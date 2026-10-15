import { viem } from "hardhat";
async function main() {
  const engine = await viem.getContractAt("RouletteEngine", "0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1");
  for (let i = 0; i < 40; i++) {
    const round = await engine.read.currentGlobalRound();
    const phase = await engine.read.roundPhase([round]);
    const d = await engine.read.roundDiagnostics([round]);
    const pending = await engine.read.hasPendingVrf();
    console.log(JSON.stringify({ i, round: round.toString(), phase, pending, part: d.marketsParticipating.toString(), settled: d.marketsSettled.toString() }));
    if (phase === 1 && !pending && d.marketsParticipating === 0) {
      console.log("IDLE_OPEN");
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("No idle open round");
}
main();
