import { windowProbability } from './windowChallengeProbability';
import { exactChallengeProbability } from './challengeProbability';

/** Candidates, not live configs. Existing deployment scripts intentionally do not seed these. */
const defaults = {color:'RED' as const,targetNumber:0,targetCount:0,redRatioBps:0,windowSpins:5};
export const WINDOW_CATALOGUE = [
 {...defaults,betType:'DOZEN_PASSPORT',index:9,targetCount:3},
 {...defaults,betType:'DISTINCT_COLLECTION',index:13,targetCount:5},
 {...defaults,betType:'FIRST_RETURN',index:15},
 {...defaults,betType:'COLOR_MIRROR',index:16,windowSpins:4},
 {...defaults,betType:'STRICT_ASCENT',index:17,windowSpins:3},
 {...defaults,betType:'SUM_RANGE',index:18,windowSpins:3,targetNumber:40,redRatioBps:60},
 {...defaults,betType:'COLOR_MAJORITY',index:19},
 {...defaults,betType:'EXACT_DOZEN',index:20,targetNumber:1,targetCount:2},
];
export function windowCataloguePlan(marketId:number, minBand:number,maxBand:number,houseEdgeBps:number) {
 if(!Number.isSafeInteger(marketId)||marketId<1||marketId>0xffffffff||!Number.isInteger(houseEdgeBps)||houseEdgeBps<0||houseEdgeBps>=10000||!Number.isInteger(minBand)||!Number.isInteger(maxBand)||minBand<=10000||maxBand<minBand||maxBand>0xffffffff)throw Error('Invalid pricing inputs');
 return WINDOW_CATALOGUE.map(c=>{
  const p=c.index===9?exactChallengeProbability('PASSPORT',c.windowSpins,3):c.index===13?exactChallengeProbability('COLLECTION',c.windowSpins,c.targetCount):windowProbability(c);
  if(!p||p.wins===0n)throw Error('Unpriceable rule');
  // Gross payout and token-unit rounding both round down. No automatic band change.
  const bps=(BigInt(10000-houseEdgeBps)*p.total)/p.wins;
  const multiplierBps=Number(bps), compatible=bps>10000n&&bps>=BigInt(minBand)&&bps<=BigInt(maxBand);
  return {name:c.betType,probability:{wins:p.wins.toString(),total:p.total.toString()},houseEdgeBps,compatible,
   config:{marketId,betType:c.index,color:c.color==='RED'?0:1,targetNumber:c.targetNumber,targetCount:c.targetCount,redRatioBps:c.redRatioBps,windowSpins:c.windowSpins,multiplierBps,minStake:0n,maxStake:0n}};
 });
}
