import { viem } from 'hardhat';
import { isAddress } from 'viem';

/** Operator worker. Read-only unless FUNDING_APPLY=true; never call AMM execution from the settlement transaction.
 * Run from a supervised service every minute. Contract cooldown/failure limits remain authoritative. */
const observationTimes = new Map<string, bigint>();
async function main() {
  const address = process.env.FUNDER_ADDRESS;
  if (!address || !isAddress(address)) throw new Error('FUNDER_ADDRESS is required');
  const apply = process.env.FUNDING_APPLY === 'true';
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  const expected = process.env.FUNDING_EXPECTED_CHAIN_ID;
  if (apply && !expected) throw new Error('FUNDING_EXPECTED_CHAIN_ID is required before writes');
  if (expected && (!/^\d+$/.test(expected) || Number(expected) !== chainId)) throw new Error('Funding keeper chain mismatch');
  if (apply && chainId === 42161 && process.env.CONFIRM_MAINNET_FUNDING !== 'arbitrum-one:42161') throw new Error('Mainnet funding requires CONFIRM_MAINNET_FUNDING=arbitrum-one:42161');
  console.log(JSON.stringify({ chainId, funder: address, mode: apply ? 'execute' : 'read-only' }));
  const funder = await viem.getContractAt('BRBJackpotFunder', address);
  const engine = await viem.getContractAt('RouletteEngine', await funder.read.engine());
  if ((await engine.read.JACKPOT_FUNDER()).toLowerCase() !== address.toLowerCase()) throw new Error('Funder is not active on this engine');
  const registry = await viem.getContractAt('MarketRegistry', await engine.read.REGISTRY());
  const count = Number(await registry.read.marketCount());
  const after = Number(process.env.AFTER_MARKET_ID ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid AFTER_MARKET_ID');
  const now = (await client.getBlock()).timestamp;
  const maxJobs = Number(process.env.MAX_FUNDING_MARKETS ?? 10);
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10) throw new Error('MAX_FUNDING_MARKETS must be 1-10');
  const ready: { id: number; next: bigint }[] = [];
  let observations = 0;
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
      const key = address.toLowerCase() + ':' + cfg.asset.toLowerCase();
      if (apply && observations < 10 && now - (observationTimes.get(key) ?? 0n) >= 600n) {
        observations++;
        observationTimes.set(key, now);
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
    if (attempts < 5 && next <= now) ready.push({ id, next });
  }
  // Oldest ready work wins; continuously active early market IDs cannot starve the others.
  const markets = ready.sort((a, b) => a.next < b.next ? -1 : a.next > b.next ? 1 : a.id - b.id)
    .slice(0, maxJobs).map(x => x.id);
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
      // Transport errors can contain credential-bearing RPC URLs.
      console.error('Funding worker cycle failed; inspect confirmed hashes and queue state before retrying.');
      if (cycles === 1) process.exitCode = 1;
    }
    if (cycle + 1 < cycles && !stopping) await new Promise(resolve => setTimeout(resolve, 60000));
  }
}
run().catch(() => { console.error('Funding worker failed'); process.exitCode = 1; });
