import { viem } from "hardhat";
import { getAddress, parseAbi, zeroHash } from "viem";
import { readFileSync, writeFileSync } from "node:fs";

const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
async function main() {
  const rehearsal = JSON.parse(readFileSync("reports/upgrades/sepolia-engine-rehearsal.json", "utf8"));
  const journal = JSON.parse(readFileSync("reports/upgrades/sepolia-engine-live.json", "utf8"));
  const client = await viem.getPublicClient();
  if (await client.getChainId() !== 421614) throw new Error("Wrong verification chain");
  const receipt = await client.getTransactionReceipt({ hash: journal.upgradeTx });
  if (receipt.status !== "success") throw new Error("Upgrade receipt failed");
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementation = getAddress(`0x${(await client.getStorageAt({ address: journal.engineProxy, slot }))!.slice(-40)}`);
  if (implementation.toLowerCase() !== journal.newImplementation.toLowerCase()) throw new Error("Wrong live implementation");
  const code = await client.getBytecode({ address: implementation });
  if (!code || (code.length - 2) / 2 > 24576) throw new Error("Implementation size/code invalid");
  const engine = await viem.getContractAt("RouletteEngine", journal.engineProxy);
  const wiring = await Promise.all([engine.read.REGISTRY(), engine.read.JACKPOT_FUNDER(), engine.read.JACKPOT_TREASURY(), engine.read.UPKEEP_SCHEDULER(), engine.read.VRF_SUBSCRIPTION_ID(), engine.read.VRF_CALLBACK_GAS_LIMIT(), engine.read.payoutParallelLaneCount()]);
  const registry = await viem.getContractAt("MarketRegistry", wiring[0] as `0x${string}`);
  const markets = [];
  for (let i = 1; i <= Number(await registry.read.marketCount()); i++) {
    const cfg = await registry.read.getMarket([i]);
    const bank = await viem.getContractAt("BankVault4626", cfg.bank);
    const balance = await client.readContract({ address: cfg.asset, abi: parseAbi(["function balanceOf(address) view returns(uint256)"]), functionName: "balanceOf", args: [cfg.bank] });
    markets.push({ cfg, supply: await bank.read.totalSupply(), assets: await bank.read.totalAssets(), balance });
  }
  const round = await engine.read.currentGlobalRound();
  const state = { wiring, markets, round, diagnostics: await engine.read.roundDiagnostics([BigInt(rehearsal.state.round)]), admin: await engine.read.hasRole([zeroHash, rehearsal.admin]) };
  if (json(state).toLowerCase() !== json(rehearsal.state).toLowerCase()) throw new Error("Live state differs from pre-upgrade rehearsal; inspect legitimate intervening activity");
  const scheduler = await viem.getContractAt("UpkeepScheduler", await engine.read.UPKEEP_SCHEDULER());
  const lanes = Number(await engine.read.payoutParallelLaneCount());
  const { encodeAbiParameters } = await import("viem");
  const upkeep = [];
  for (let lane = 0; lane < lanes; lane++) {
    const data = lane === 0 ? "0x" : encodeAbiParameters([{ type: "uint256" }], [BigInt(lane)]);
    const [needed] = await scheduler.read.checkUpkeep([data]);
    upkeep.push({ lane, needed });
  }
  const report = { chainId: 421614, block: await client.getBlockNumber(), proxy: journal.engineProxy, implementation, runtimeBytes: (code.length - 2) / 2, upgradeTx: journal.upgradeTx, stateMatchesPreUpgrade: true, pendingVrf: await engine.read.hasPendingVrf(), upkeep, state };
  writeFileSync("reports/upgrades/sepolia-engine-postcheck.json", json(report) + "\n");
  console.log(json({ proxy: report.proxy, implementation, runtimeBytes: report.runtimeBytes, stateMatchesPreUpgrade: true, pendingVrf: report.pendingVrf, upkeep }));
}
main().catch(() => { console.error("Post-upgrade readback failed; inspect receipt, implementation and current state. Transport details withheld."); process.exitCode = 1; });
