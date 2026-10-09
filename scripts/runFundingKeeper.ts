import { viem } from 'hardhat';
import { isAddress } from 'viem';

/** Operator worker. Read-only unless FUNDING_APPLY=true; never run during settlement.
 * Run from a supervised service every minute. Contract cooldown/failure limits remain authoritative. */
async function main() {
  const address = process.env.FUNDER_ADDRESS;
  if (!address || !isAddress(address)) throw new Error('FUNDER_ADDRESS is required');
  const apply = process.env.FUNDING_APPLY === 'true';
  const funder = await viem.getContractAt('BRBJackpotFunder', address);
  const engine = await viem.getContractAt('RouletteEngine', await funder.read.engine());
  if ((await engine.read.JACKPOT_FUNDER()).toLowerCase() !== address.toLowerCase()) throw new Error('Funder is not active on this engine');
  const registry = await viem.getContractAt('MarketRegistry', await engine.read.REGISTRY());
  const count = Number(await registry.read.marketCount());
  const after = Number(process.env.AFTER_MARKET_ID ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid AFTER_MARKET_ID');
  const client = await viem.getPublicClient();
  const now = (await client.getBlock()).timestamp;
  const markets: number[] = [];
  const observed = new Set<string>();
  for (let id = after + 1; id <= Math.min(count, after + 100); id++) {
    const a = await funder.read.fundingAccounts([id]);
    const debt = await funder.read.pendingBrbByMarket([id]);
    const attempts = await funder.read.consecutiveFailures([id]);
    const next = await funder.read.nextAttemptAt([id]);
    const cfg = await registry.read.getMarket([id]);
    if (cfg.asset.toLowerCase() !== a[0].toLowerCase() && a[2] > 0n) throw new Error(`Market ${id} changed asset; explicit migration required`);
    // Warm observations even before the first successful swap, for every registered asset.
    if (!observed.has(cfg.asset.toLowerCase())) {
      observed.add(cfg.asset.toLowerCase());
      if (apply) {
        try {
          const hash = await funder.write.updateObservation([cfg.asset], { gas: 200000n });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') console.error(`Observation failed for ${cfg.asset}: ${hash}`);
        } catch { console.error(`Observation unavailable for ${cfg.asset}`); }
      }
    }
    if (a[1] === 0n && debt[0] === 0n && debt[1] === 0n) continue;
    console.log(JSON.stringify({ market: id, queued: a[1].toString(), pendingTreasury: debt[0].toString(),
      pendingBurn: debt[1].toString(), failures: attempts, nextAttemptAt: next.toString(), stopped: attempts >= 5 }));
    if (attempts < 5 && next <= now) markets.push(id);
  }
  if (apply) {
    for (let i = 0; i < markets.length; i += 10) {
      const batch = markets.slice(i, i + 10);
      const hash = await funder.write.processFundingBatch([batch], { gas: BigInt(batch.length) * 650000n + 150000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Funding batch failed: ${hash}`);
      console.log(`Funding batch confirmed: ${hash}`);
    }
  }
  console.log(`Inspected markets ${after + 1}-${Math.min(count, after + 100)}. Mode: ${apply ? 'execute' : 'read-only'}.`);
}
async function run() {
  const cycles = Number(process.env.FUNDING_KEEPER_CYCLES ?? 1);
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 1440) throw new Error('FUNDING_KEEPER_CYCLES must be 1-1440');
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  for (let cycle = 0; cycle < cycles && !stopping; cycle++) {
    try { await main(); }
    catch (error) {
      console.error(error instanceof Error ? error.message : 'Funding worker failed');
      if (cycles === 1) process.exitCode = 1;
    }
    if (cycle + 1 < cycles && !stopping) await new Promise(resolve => setTimeout(resolve, 60000));
  }
}
run().catch(error => { console.error(error instanceof Error ? error.message : 'Funding worker failed'); process.exitCode = 1; });
