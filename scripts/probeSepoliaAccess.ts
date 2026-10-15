import { viem } from "hardhat";
async function main() {
  const engine = await viem.getContractAt("RouletteEngine", "0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1");
  const round = await engine.read.currentGlobalRound();
  const phase = await engine.read.roundPhase([round]);
  const pending = await engine.read.hasPendingVrf();
  const d = await engine.read.roundDiagnostics([round]);
  const lockAt = await engine.read.roundLockAt?.([round]).catch(() => null);
  let lock: unknown = null;
  try {
    // storage helper if exposed
    const gr = await engine.read.globalRoundState([round]);
    lock = { vrfRequested: gr.vrfRequested, vrfFulfilled: gr.vrfFulfilled, winningNumber: gr.winningNumber };
  } catch {}
  const registry = await viem.getContractAt("MarketRegistry", await engine.read.REGISTRY());
  const markets = Number(await registry.read.marketCount());
  const marketInfo = [];
  for (let i = 1; i <= markets; i++) {
    const m = await registry.read.getMarket([i]);
    const st = await engine.read.marketRoundStateByRound([round, i]);
    marketInfo.push({
      id: i,
      asset: m.asset,
      bank: m.bank,
      betCount: st.totals.betCount.toString(),
      settled: st.settled,
      winningBetCount: st.winningBetCount.toString(),
    });
  }
  console.log(JSON.stringify({ round: round.toString(), phase, pending, diagnostics: {
    participating: d.marketsParticipating.toString(),
    settled: d.marketsSettled.toString(),
  }, global: lock, markets: marketInfo }, null, 2));
}
main();
