import {expect} from 'chai';
import {windowCataloguePlan} from '../scripts/utils/windowChallengeCatalogue';
import {windowProbability} from '../scripts/utils/windowChallengeProbability';
describe('Window challenge pricing',()=>{
 it('prices all eight offers exactly and leaves stake limits disabled',()=>{
  const plan=windowCataloguePlan(1,10001,5000000,500);expect(plan).length(8);
  for(const p of plan){const w=BigInt(p.probability.wins),n=BigInt(p.probability.total);expect(BigInt(p.config.multiplierBps)*w<=9500n*n).eq(true);expect((BigInt(p.config.multiplierBps)+1n)*w>9500n*n).eq(true);expect(p.config.minStake).eq(0n);expect(p.config.maxStake).eq(0n);expect(p.compatible).eq(true);}
 });
 it('never raises cheap odds to the existing 5x band',()=>{
  const p=windowCataloguePlan(1,50000,5000000,500);expect(p.some(x=>!x.compatible)).eq(true);
  expect(p.filter(x=>x.compatible).map(x=>x.name)).deep.eq(['FIRST_RETURN','COLOR_MIRROR','STRICT_ASCENT']);
 });
 it('matches closed form probabilities and rejects malformed sum bounds',()=>{
  const b={betType:'SUM_RANGE',color:'RED' as const,targetNumber:0,targetCount:0,redRatioBps:0,windowSpins:3};
  expect(windowProbability(b)).deep.eq({wins:1n,total:37n**3n});
  expect(windowProbability({...b,targetNumber:108,redRatioBps:108})).deep.eq({wins:1n,total:37n**3n});
  expect(windowProbability({...b,redRatioBps:108})).eq(null);
 });
});
