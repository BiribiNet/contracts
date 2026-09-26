// Exact mathematical model. Keep parity with frontend/lib/side-bet/window-challenges.ts.
type Rule = {betType:string;color:'RED'|'BLACK';windowSpins:number;targetNumber:number;targetCount:number;redRatioBps:number};
export const WINDOW_TYPES = ["FIRST_RETURN", "COLOR_MIRROR", "STRICT_ASCENT", "SUM_RANGE", "COLOR_MAJORITY", "EXACT_DOZEN"];
export function validWindowRule(b: Rule): boolean {
  if (![b.windowSpins,b.targetNumber,b.targetCount,b.redRatioBps].every(Number.isSafeInteger) || b.windowSpins < 2 || b.windowSpins > 64 || b.targetCount < 0 || b.targetNumber < 0 || b.redRatioBps < 0 || !["RED","BLACK"].includes(b.color)) return false;
  if (b.betType === "SUM_RANGE") return b.windowSpins === 3 && b.targetCount === 0 && b.targetNumber <= b.redRatioBps && b.redRatioBps <= 108 && !(b.targetNumber === 0 && b.redRatioBps === 108);
  if (b.betType === "EXACT_DOZEN") return b.targetNumber >= 1 && b.targetNumber <= 3 && b.targetCount <= b.windowSpins && b.redRatioBps === 0;
  return WINDOW_TYPES.includes(b.betType) && b.targetNumber === 0 && b.targetCount === 0 && b.redRatioBps === 0 && (b.betType !== "COLOR_MIRROR" || b.windowSpins === 4) && (b.betType !== "STRICT_ASCENT" || b.windowSpins === 3);
}

function choose(n:number,k:number):bigint { if(k<0||k>n)return 0n; let v=1n;for(let i=1;i<=k;i++)v=v*BigInt(n-i+1)/BigInt(i);return v; }
/** Exact counts under independent uniform European roulette outcomes; never inferred from price. */
export function windowProbability(b: Rule):{wins:bigint;total:bigint}|null {
  if(!validWindowRule(b))return null;
  const w=b.windowSpins,total=37n**BigInt(w);
  if(b.betType==="FIRST_RETURN")return {wins:total-37n*36n**BigInt(w-1),total};
  if(b.betType==="COLOR_MIRROR")return {wins:2n*18n**4n,total};
  if(b.betType==="STRICT_ASCENT")return {wins:choose(37,3),total};
  if(b.betType==="EXACT_DOZEN")return {wins:choose(w,b.targetCount)*12n**BigInt(b.targetCount)*25n**BigInt(w-b.targetCount),total};
  if(b.betType==="SUM_RANGE") {let wins=0n;for(let a=0;a<=36;a++)for(let c=0;c<=36;c++){const low=Math.max(0,b.targetNumber-a-c),high=Math.min(36,b.redRatioBps-a-c);if(low<=high)wins+=BigInt(high-low+1);}return {wins,total};}
  // Symmetry: strictly more red than black = (all sequences - ties)/2. Zero is neutral.
  let ties=0n;for(let k=0;k*2<=w;k++)ties+=choose(w,k)*choose(w-k,k)*18n**BigInt(2*k);
  return {wins:(total-ties)/2n,total};
}
