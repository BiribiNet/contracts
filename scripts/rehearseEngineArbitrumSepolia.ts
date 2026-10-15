import { network, viem } from "hardhat";
import { vars } from "hardhat/config";
import { createPublicClient, http, getAddress, parseAbi, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync } from "node:fs";
import { deployRouletteEngineLibraries } from "./utils/deployRouletteEngineLibraries";

const proxy = getAddress("0x7eb8110d9e84d3c32fa6468d13ea2bc81544acf1");
const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
async function main() {
  if (network.name !== "hardhat") throw new Error("Rehearsal must use local Hardhat");
  const url = process.env.ARBITRUM_SEPOLIA_RPC_URL || vars.get("ARBITRUM_SEPOLIA_RPC_URL");
  const source = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20000 }) });
  if (await source.getChainId() !== 421614) throw new Error("Wrong fork source chain");
  const block = await source.getBlockNumber();
  const key = vars.get("BRB_KEY");
  const admin = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
  await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url, blockNumber: Number(block) } }] });
  const client = await viem.getPublicClient();
  if (await client.getChainId() !== 31337) throw new Error("Writes require isolated local chain");
  const engine = await viem.getContractAt("RouletteEngine", proxy);
  if (!await engine.read.hasRole([zeroHash, admin])) throw new Error("Configured signer is not engine administrator");
  const previous = getAddress(`0x${(await client.getStorageAt({ address: proxy, slot }))!.slice(-40)}`);
  const round = await engine.read.currentGlobalRound();
  const diagnostics = await engine.read.roundDiagnostics([round]);
  const pending = await engine.read.hasPendingVrf();
  console.log(json({ sourceChainId: 421614, block, proxy, previous, admin, round, pending, diagnostics }));
  if (pending || diagnostics.marketsParticipating !== diagnostics.marketsSettled) throw new Error("Finish pending draw/settlement before upgrading");
  const snapshot = async () => {
    const wiring = await Promise.all([engine.read.REGISTRY(), engine.read.JACKPOT_FUNDER(), engine.read.JACKPOT_TREASURY(), engine.read.UPKEEP_SCHEDULER(), engine.read.VRF_SUBSCRIPTION_ID(), engine.read.VRF_CALLBACK_GAS_LIMIT(), engine.read.payoutParallelLaneCount()]);
    const registry = await viem.getContractAt("MarketRegistry", wiring[0] as `0x${string}`);
    const markets = [];
    for (let i = 1; i <= Number(await registry.read.marketCount()); i++) {
      const cfg = await registry.read.getMarket([i]);
      const bank = await viem.getContractAt("BankVault4626", cfg.bank);
      const balance = await client.readContract({ address: cfg.asset, abi: parseAbi(["function balanceOf(address) view returns(uint256)"]), functionName: "balanceOf", args: [cfg.bank] });
      markets.push({ cfg, supply: await bank.read.totalSupply(), assets: await bank.read.totalAssets(), balance });
    }
    return json({ wiring, markets, round: await engine.read.currentGlobalRound(), diagnostics: await engine.read.roundDiagnostics([round]), admin: await engine.read.hasRole([zeroHash, admin]) });
  };
  const before = await snapshot();
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [admin] });
  await network.provider.request({ method: "hardhat_setBalance", params: [admin, "0x56bc75e2d63100000"] });
  const [wallet] = await viem.getWalletClients();
  const { engineLinks } = await deployRouletteEngineLibraries(wallet.account);
  const previousContract = await viem.getContractAt("RouletteEngine", previous);
  const constructorArgs = ["0x5CE8D5A2BC84beb22a398CCA51996F7930313D61", await previousContract.read.VRF_KEY_HASH_2_GWEI(), await previousContract.read.VRF_KEY_HASH_30_GWEI(), await previousContract.read.VRF_KEY_HASH_150_GWEI(), await previousContract.read.VRF_CONFIRMATIONS(), await previousContract.read.BRB_REFERRAL()] as const;
  const implementation = await viem.deployContract("RouletteEngine", constructorArgs, { libraries: engineLinks });
  const hash = await engine.write.upgradeToAndCall([implementation.address, "0x"], { account: admin });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || await snapshot() !== before) throw new Error("Upgrade did not preserve state");
  const actual = getAddress(`0x${(await client.getStorageAt({ address: proxy, slot }))!.slice(-40)}`);
  if (actual.toLowerCase() !== implementation.address.toLowerCase()) throw new Error("Implementation slot mismatch");
  const scheduler = await viem.getContractAt("UpkeepScheduler", await engine.read.UPKEEP_SCHEDULER());
  await scheduler.read.checkUpkeep(["0x"]);
  const report = { sourceChainId: 421614, localChainId: 31337, pinnedBlock: block, proxy, previousImplementation: previous, admin, implementation: implementation.address, constructorArgs, statePreserved: true, schedulerReadPassed: true, state: JSON.parse(before) };
  mkdirSync("reports/upgrades", { recursive: true });
  writeFileSync("reports/upgrades/sepolia-engine-rehearsal.json", json(report) + "\n");
  console.log("Sepolia Engine fork upgrade passed; state preserved and scheduler read succeeded.");
}
main().catch((error) => { console.error(String(error.shortMessage || error.message).split("\n")[0].replace(/https?:\/\/[^\s]+/g, "[redacted RPC]")); console.error("Sepolia fork rehearsal failed. Inspect private diagnostics and pending round state before proceeding."); process.exitCode = 1; });
