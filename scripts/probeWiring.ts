import { viem } from "hardhat";
import { readFileSync } from "fs";
async function main() {
  const deploy = JSON.parse(readFileSync("../subgraph/deployments/arbitrum-sepolia.json", "utf8"));
  const engine = await viem.getContractAt("RouletteEngine", deploy.addresses.roulette);
  const registry = await viem.getContractAt("MarketRegistry", await engine.read.REGISTRY());
  const market = await registry.read.getMarket([3]);
  const funder = await engine.read.JACKPOT_FUNDER();
  console.log(JSON.stringify({
    marketAsset: market.asset,
    deployBrb: deploy.addresses.brb,
    assetMatch: market.asset.toLowerCase() === deploy.addresses.brb.toLowerCase(),
    liveFunder: funder,
    deployFunder: deploy.addresses.jackpotFunder,
    funderMatch: funder.toLowerCase() === deploy.addresses.jackpotFunder.toLowerCase(),
  }, null, 2));
}
main();
