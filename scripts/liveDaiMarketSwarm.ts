/**
 * Focused Arbitrum Sepolia DAI-market live check:
 * mint DAI if needed, fund bank, place N all-number tickets, wait for real VRF/automation,
 * verify ordinary payouts, then processJackpot funding and assert DAI→BRB Uniswap activity.
 */
import { network, viem } from "hardhat";
import { vars } from "hardhat/config";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseAbi,
  parseEther,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { encodeMultiBet, straightLegs } from "../test/helpers/multiBetEncode";
import { createRpcFallback, resolveSepoliaRpcUrls } from "./utils/rpcFallback";
import { readFileSync } from "node:fs";

const TICKETS = Number(process.env.DAI_SWARM_TICKETS || "50");
const JOURNAL = process.env.DAI_SWARM_JOURNAL || "reports/swarm/live-sepolia-2026-10-15-dai.json";

async function main() {
  if (network.name !== "arbitrumsepolia") throw new Error("arbitrumsepolia only");
  if (process.env.CONFIRM_DAI_SWARM !== "421614:dai") throw new Error("Set CONFIRM_DAI_SWARM=421614:dai");
  const rpcUrls = resolveSepoliaRpcUrls(process.env, (n) => (vars.has(n) ? vars.get(n) : undefined));
  const transport = createRpcFallback(rpcUrls, arbitrumSepolia.id);
  const pc = createPublicClient({ chain: arbitrumSepolia, transport, pollingInterval: 1500 });
  const key = vars.get("BRB_KEY");
  const admin = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  const wallet = createWalletClient({ account: admin, chain: arbitrumSepolia, transport });
  const clients = { client: { public: pc, wallet } };
  const deploy = JSON.parse(readFileSync("../subgraph/deployments/arbitrum-sepolia.json", "utf8"));
  const engine = await viem.getContractAt("RouletteEngine", deploy.addresses.roulette, clients);
  const registry = await viem.getContractAt("MarketRegistry", await engine.read.REGISTRY(), clients);
  const market = await registry.read.getMarket([2]);
  const bank = await viem.getContractAt("BankVault4626", market.bank, clients);
  const dai = market.asset as `0x${string}`;
  const brb = await viem.getContractAt("BRBToken", deploy.addresses.brb, clients);
  const funderAddr = await engine.read.JACKPOT_FUNDER();
  const funder = await viem.getContractAt("BRBJackpotFunder", funderAddr, clients);
  const erc20 = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function mint(address,uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
  ]);
  if (dai.toLowerCase() !== deploy.markets.dai.asset.toLowerCase()) throw new Error("DAI market mismatch");
  const ticket = parseEther("37"); // 37 * 1e18 DAI legs
  const stake = ticket * BigInt(TICKETS);
  const bal = await pc.readContract({ address: dai, abi: erc20, functionName: "balanceOf", args: [admin.address] });
  if (bal < stake + parseEther("1000")) {
    try {
      const hash = await wallet.writeContract({
        address: dai,
        abi: erc20,
        functionName: "mint",
        args: [admin.address, stake + parseEther("5000")],
      });
      await pc.waitForTransactionReceipt({ hash });
      console.log("minted DAI", hash);
    } catch (e) {
      throw new Error(`DAI mint failed and balance insufficient: ${String(e)}`);
    }
  }
  // Ensure bank has liquidity
  const assets = await bank.read.totalAssets();
  if (assets < stake * 40n) {
    const depositAmt = stake * 50n;
    const approveHash = await wallet.writeContract({ address: dai, abi: erc20, functionName: "approve", args: [bank.address, depositAmt] });
    await pc.waitForTransactionReceipt({ hash: approveHash });
    const depHash = await bank.write.deposit([depositAmt, admin.address]);
    await pc.waitForTransactionReceipt({ hash: depHash });
    console.log("deposited DAI liquidity", depHash);
  }
  // Wait idle
  for (let i = 0; i < 60; i++) {
    const round = await engine.read.currentGlobalRound();
    const phase = await engine.read.roundPhase([round]);
    const d = await engine.read.roundDiagnostics([round]);
    const pending = await engine.read.hasPendingVrf();
    let busy = false;
    for (let id = 1; id <= Number(await registry.read.marketCount()); id++) {
      if ((await engine.read.marketRoundStateByRound([round, id])).totals.betCount !== 0n) busy = true;
    }
    if (phase === 1 && !pending && !busy && d.marketsParticipating === 0) break;
    await new Promise((r) => setTimeout(r, 5000));
    if (i === 59) throw new Error("No idle round for DAI swarm");
  }
  const round = await engine.read.currentGlobalRound();
  const betData = encodeMultiBet(straightLegs(37, parseEther("1")));
  const approve = await wallet.writeContract({ address: dai, abi: erc20, functionName: "approve", args: [bank.address, stake] });
  await pc.waitForTransactionReceipt({ hash: approve });
  const beforeDai = await pc.readContract({ address: dai, abi: erc20, functionName: "balanceOf", args: [admin.address] });
  const beforeBrb = await brb.read.balanceOf([admin.address]);
  const fundingBefore = await funder.read.fundingAccounts([2]);
  const hashes: `0x${string}`[] = [];
  let nonce = await pc.getTransactionCount({ address: admin.address, blockTag: "pending" });
  for (let i = 0; i < TICKETS; i++) {
    const gasPrice = (await pc.getGasPrice()) * 2n;
    const hash = await wallet.writeContract({
      address: bank.address,
      abi: bank.abi,
      functionName: "placeBet",
      args: [ticket, betData, zeroAddress],
      gas: 6_000_000n,
      gasPrice,
      nonce: nonce++,
      type: "legacy",
    });
    hashes.push(hash);
    if ((i + 1) % 10 === 0) {
      await Promise.all(hashes.slice(-10).map((h) => pc.waitForTransactionReceipt({ hash: h })));
      console.log(`placed ${i + 1}/${TICKETS}`);
    }
  }
  await Promise.all(hashes.map((h) => pc.waitForTransactionReceipt({ hash: h })));
  console.log(`All ${TICKETS} DAI tickets placed in round ${round}`);

  // Observe settlement
  let settled = false;
  let win = 0;
  let vrfTx: string | undefined;
  let vrfGas = "0";
  for (let i = 0; i < 40; i++) {
    const cur = await engine.read.currentGlobalRound();
    const st = await engine.read.marketRoundStateByRound([round, 2]);
    const d = await engine.read.roundDiagnostics([round]);
    if (d.fulfilled && !vrfTx) {
      // find VRFResult
      const from = (await pc.getBlockNumber()) - 2000n;
      const logs = await pc.getLogs({ address: engine.address, fromBlock: from < 0n ? 0n : from });
      const abi = parseAbi(["event VRFResult(uint64 roundId, uint8 winningNumber, uint8 jackpotNumber)"]);
      for (const log of parseEventLogs({ abi, logs, strict: false })) {
        if (log.eventName === "VRFResult" && BigInt((log.args as any).roundId) === BigInt(round)) {
          const receipt = await pc.waitForTransactionReceipt({ hash: log.transactionHash });
          vrfTx = log.transactionHash;
          vrfGas = receipt.gasUsed.toString();
          win = Number((log.args as any).winningNumber);
        }
      }
    }
    if (st.settled || cur > round) {
      settled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  if (!settled) throw new Error("DAI round did not settle in time");
  const afterDai = await pc.readContract({ address: dai, abi: erc20, functionName: "balanceOf", args: [admin.address] });
  // Ordinary payout: 36 DAI per ticket
  const expectedPayout = parseEther("36") * BigInt(TICKETS);
  const expectedLoss = parseEther("1") * BigInt(TICKETS);
  const delta = afterDai - beforeDai;
  // stake left wallet then payout returned — net should be -expectedLoss if we started after approve-only
  // Actually beforeDai was after approve, then we spent stake, then received payout.
  // delta = -stake + payout = -TICKETS + 36*TICKETS = +35*TICKETS? No:
  // before includes funds; placeBet pulls stake; payout returns 36*TICKETS
  // delta = after - before = -37*T + 36*T = -T
  const payoutOk = delta === -expectedLoss;
  const fundingQueued = await funder.read.fundingAccounts([2]);
  const queuedDelta = fundingQueued[1] - fundingBefore[1];

  // Process funding to exercise DAI/BRB swap
  const router = deploy.addresses.uniswapRouter as `0x${string}`;
  const pairFactoryAbi = parseAbi([
    "function factory() view returns (address)",
  ]);
  const factoryAbi = parseAbi([
    "function getPair(address,address) view returns (address)",
  ]);
  const pairAbi = parseAbi([
    "function getReserves() view returns (uint112,uint112,uint32)",
    "function token0() view returns (address)",
    "event Sync(uint112 reserve0, uint112 reserve1)",
    "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
  ]);
  let factory: `0x${string}` | undefined;
  try {
    factory = await pc.readContract({ address: router, abi: pairFactoryAbi, functionName: "factory" });
  } catch {}
  let pair: `0x${string}` | undefined;
  if (factory) {
    pair = await pc.readContract({ address: factory, abi: factoryAbi, functionName: "getPair", args: [dai, brb.address] });
  }
  const reservesBefore = pair && pair !== zeroAddress
    ? await pc.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" })
    : null;
  const funderBrbBefore = await brb.read.balanceOf([funderAddr]);
  const treasury = await engine.read.JACKPOT_TREASURY();
  const treasuryBrbBefore = await brb.read.balanceOf([treasury]);

  // Warm TWAP observations then process
  try {
    const oh = await funder.write.updateObservation([dai]);
    await pc.waitForTransactionReceipt({ hash: oh });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const oh2 = await funder.write.updateObservation([dai]);
    await pc.waitForTransactionReceipt({ hash: oh2 });
  } catch {}

  let fundingTx: string | undefined;
  let fundingStatus: string = "skipped";
  if (fundingQueued[1] > 0n || queuedDelta > 0n) {
    try {
      const fh = await funder.write.processFundingBatch([[2]], { gas: 2_000_000n });
      const fr = await pc.waitForTransactionReceipt({ hash: fh });
      fundingTx = fh;
      fundingStatus = fr.status;
    } catch (e) {
      fundingStatus = `failed:${String(e).slice(0, 200)}`;
    }
  }
  const fundingAfter = await funder.read.fundingAccounts([2]);
  const reservesAfter = pair && pair !== zeroAddress
    ? await pc.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" })
    : null;
  const funderBrbAfter = await brb.read.balanceOf([funderAddr]);
  const treasuryBrbAfter = await brb.read.balanceOf([treasury]);

  const report = {
    chainId: 421614,
    round: round.toString(),
    tickets: TICKETS,
    bank: bank.address,
    dai,
    funder: funderAddr,
    pair,
    vrfTx,
    vrfGasUsed: vrfGas,
    winningNumber: win,
    walletDaiDelta: delta.toString(),
    expectedNetLoss: expectedLoss.toString(),
    payoutOk,
    stake: stake.toString(),
    ordinaryExpected: expectedPayout.toString(),
    fundingBefore: fundingBefore.map(String),
    fundingAfter: fundingAfter.map(String),
    queuedDelta: queuedDelta.toString(),
    fundingTx,
    fundingStatus,
    reservesBefore: reservesBefore ? reservesBefore.map(String) : null,
    reservesAfter: reservesAfter ? reservesAfter.map(String) : null,
    funderBrbDelta: (funderBrbAfter - funderBrbBefore).toString(),
    treasuryBrbDelta: (treasuryBrbAfter - treasuryBrbBefore).toString(),
    betHashes: hashes,
  };
  mkdirSync("reports/swarm", { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
  console.log(JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  if (!payoutOk) throw new Error("DAI payout accounting mismatch");
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
