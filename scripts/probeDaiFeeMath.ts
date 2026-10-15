import { viem } from "hardhat";
import { parseAbi, formatEther, parseEther } from "viem";
import { readFileSync } from "fs";
async function main() {
  const report = JSON.parse(readFileSync("reports/swarm/live-sepolia-2026-10-15-dai.json", "utf8"));
  const pc = await viem.getPublicClient();
  const funder = await viem.getContractAt("BRBJackpotFunder", report.funder);
  const engine = await viem.getContractAt("RouletteEngine", "0x7eb8110d9E84D3c32fA6468d13Ea2bC81544acf1");
  const pair = report.pair as `0x${string}`;
  const pairAbi = parseAbi([
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function totalSupply() view returns (uint256)",
  ]);
  const [r0, r1] = await pc.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" });
  const t0 = await pc.readContract({ address: pair, abi: pairAbi, functionName: "token0" });
  const t1 = await pc.readContract({ address: pair, abi: pairAbi, functionName: "token1" });
  const swapBps = await funder.read.swapAssetTotalBps();
  const num = await funder.read.treasuryBrbNumerator();
  const den = await funder.read.treasuryBrbDenominator();
  const slip = await funder.read.slippageBps();
  // Reconstruct expected fee from 50 tickets all-number: stake 1850, pay 1800, profit 50
  const profit = parseEther("50");
  const queued = (profit * swapBps) / 10000n;
  const infraBps = 200n; // typical 2% if engine uses that — check infra from funding account fields
  const acct = await funder.read.fundingAccounts([2]);
  // Uniswap v2 amountOut for 1.5 DAI into token0 pool
  const amountIn = parseEther("1.5");
  const daiIs0 = t0.toLowerCase() === report.dai.toLowerCase();
  const reserveIn = daiIs0 ? r0 : r1;
  const reserveOut = daiIs0 ? r1 : r0;
  // at time of swap reserves were report.reservesBefore
  const rb0 = BigInt(report.reservesBefore[0]);
  const rb1 = BigInt(report.reservesBefore[1]);
  const rin = daiIs0 ? rb0 : rb1;
  const rout = daiIs0 ? rb1 : rb0;
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * rout;
  const denominator = rin * 1000n + amountInWithFee;
  const expectedOut = numerator / denominator;
  const treasuryShare = (expectedOut * num) / den;
  const burnShare = expectedOut - treasuryShare;
  console.log(JSON.stringify({
    pair: { token0: t0, token1: t1, reserve0: formatEther(r0), reserve1: formatEther(r1),
      reserve0Before: formatEther(rb0), reserve1Before: formatEther(rb1) },
    funder: { swapAssetTotalBps: swapBps.toString(), treasurySplit: `${num}/${den}`, slippageBps: slip.toString() },
    feeMath: {
      houseProfitDAI: formatEther(profit),
      expectedQueuedDAI: formatEther(queued),
      observedQueuedDelta: formatEther(BigInt(report.queuedDelta)),
      matchQueued: queued === BigInt(report.queuedDelta),
    },
    swapMathAtPreReserves: {
      amountInDAI: formatEther(amountIn),
      expectedBrbOut: expectedOut.toString(),
      expectedBrbOutFmt: formatEther(expectedOut),
      observedBrbOutOfPair: (-(BigInt(report.reservesAfter[1]) - BigInt(report.reservesBefore[1]))).toString(),
      observedDaiIntoPair: (BigInt(report.reservesAfter[0]) - BigInt(report.reservesBefore[0])).toString(),
      expectedTreasury: treasuryShare.toString(),
      observedTreasury: report.treasuryBrbDelta,
      expectedBurn: burnShare.toString(),
      spotPriceBrbPerDai: Number(formatEther(rout)) / Number(formatEther(rin)),
      spotPriceDaiPerBrb: Number(formatEther(rin)) / Number(formatEther(rout)),
      poolBrbDepth: formatEther(rout),
      poolDaiDepth: formatEther(rin),
    },
    fundingAccount: acct.map(String),
  }, null, 2));
}
main();
