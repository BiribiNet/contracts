import { viem, artifacts } from "hardhat";
import { expect } from "chai";
import { funkyProbability } from "../scripts/utils/funkyProbability";
import { funkyCataloguePlan } from "../scripts/utils/funkyCatalogue";

const base = { player: "0x0000000000000000000000000000000000000001" as const, marketId: 1, stake: 1n, payout: 2n, startGlobalRound: 1n, windowSpins: 6, color: 0, targetNumber: 0, targetCount: 0, redRatioBps: 0, status: 0, placedAt: 0n, resolvedAt: 0n };
describe("Funky evaluator and catalogue", () => {
  it("keeps implementation/helper runtime and init code deployable", async () => {
    for (const name of ["SideBet", "SideBetChallengeEvaluator"]) { const a = await artifacts.readArtifact(name); expect((a.deployedBytecode.length - 2) / 2).at.most(24576); expect((a.bytecode.length - 2) / 2).at.most(49152); }
  });
  it("early duplicate wins include a non-first zero; zigzag and finish wait for completion", async () => {
    const e = await viem.deployContract("SideBetChallengeEvaluator");
    expect(await e.read.evaluate([[7,0,1,0],false,{...base,betType:21}])).deep.eq([true,true]);
    expect(await e.read.evaluate([[0,36,1],false,{...base,betType:22,windowSpins:4}])).deep.eq([false,false]);
    expect(await e.read.evaluate([[0,36,1,35],true,{...base,betType:22,windowSpins:4}])).deep.eq([true,true]);
    expect(await e.read.evaluate([[0,36,36,35],true,{...base,betType:22,windowSpins:4}])).deep.eq([true,false]);
    expect(await e.read.evaluate([[7],false,{...base,betType:24,targetNumber:7,windowSpins:5}])).deep.eq([false,false]);
    expect(await e.read.evaluate([[7,1,2,3,7],true,{...base,betType:24,targetNumber:7,windowSpins:5}])).deep.eq([true,false]);
    expect(await e.read.evaluate([[1,2,3,4,0],true,{...base,betType:24,windowSpins:5}])).deep.eq([true,true]);
    expect(await e.read.evaluate([[0,13,24,14],false,{...base,betType:23,targetCount:3,windowSpins:5}])).deep.eq([true,true]);
    expect(await e.read.evaluate([[0,13,24,37],false,{...base,betType:23,targetCount:3,windowSpins:5}])).deep.eq([false,false]);
  });
  it("prices all ten offers exactly and leaves stake limits disabled", () => {
    const plan = funkyCataloguePlan(1,50000,5000000,500);
    expect(plan).length(10);
    for (const p of plan) { const wins=BigInt(p.probability.wins), total=BigInt(p.probability.total); expect(wins > 0n && wins < total).eq(true); expect(BigInt(p.config.multiplierBps)).eq(9500n*total/wins); expect(p.config.minStake).eq(0n); expect(p.config.maxStake).eq(0n); expect(p.compatible).eq(p.config.multiplierBps >= 50000 && p.config.multiplierBps <= 5000000); }
  });
  it("rejects invalid pricing arguments and matches exact small counts", () => {
    expect(()=>funkyCataloguePlan(0,50000,5000000,500)).to.throw();
    expect(()=>funkyCataloguePlan(1,10000,5000000,500)).to.throw();
    expect(()=>funkyCataloguePlan(1,10001,5000000,10000)).to.throw();
    const rule={betType:"ANY_REPEAT",color:"RED" as const,targetNumber:0,targetCount:0,redRatioBps:0,windowSpins:2};
    expect(funkyProbability(rule)).deep.eq({wins:37n,total:1369n});
    expect(funkyProbability({...rule,betType:"ANY_DOZEN",targetCount:2})).deep.eq({wins:432n,total:1369n});
  });
});
