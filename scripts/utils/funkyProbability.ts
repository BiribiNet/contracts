
export const FUNKY_TYPES: string[] = ["ANY_REPEAT", "ZIGZAG", "ANY_DOZEN", "PHOTO_FINISH"];
type Rule = { betType: string; color: "RED" | "BLACK"; targetNumber: number; targetCount: number; redRatioBps: number; windowSpins: number };

export function validFunkyRule(b: Rule): boolean {
  if (![b.windowSpins, b.targetNumber, b.targetCount, b.redRatioBps].every(Number.isSafeInteger) || !["RED", "BLACK"].includes(b.color) || b.windowSpins < 2 || b.windowSpins > 64 || b.redRatioBps !== 0) return false;
  if (b.betType === "PHOTO_FINISH") return b.targetNumber >= 0 && b.targetNumber <= 36 && b.targetCount === 0;
  if (b.targetNumber !== 0) return false;
  if (b.betType === "ANY_DOZEN") return b.windowSpins <= 16 && b.targetCount >= 2 && b.targetCount <= b.windowSpins;
  if (b.targetCount !== 0) return false;
  return b.betType === "ZIGZAG" ? b.windowSpins === 4 : b.betType === "ANY_REPEAT" && b.windowSpins <= 16;
}

function choose(n: number, k: number): bigint {
  let v = 1n;
  for (let i = 1; i <= k; i++) v = v * BigInt(n - i + 1) / BigInt(i);
  return v;
}

/** Exact counts for independent uniform 0..36 draws; prices never determine chance. */
export function funkyProbability(b: Rule): { wins: bigint; total: bigint } | null {
  if (!validFunkyRule(b)) return null;
  const w = b.windowSpins, total = 37n ** BigInt(w);
  if (b.betType === "PHOTO_FINISH") return { wins: 36n ** BigInt(w - 1), total };
  if (b.betType === "ANY_REPEAT") {
    let distinct = 1n;
    for (let i = 0; i < w; i++) distinct *= BigInt(37 - i);
    return { wins: total - distinct, total };
  }
  if (b.betType === "ANY_DOZEN") {
    let losses = 0n;
    for (let a = 0; a < b.targetCount; a++) for (let c = 0; c < b.targetCount && a + c <= w; c++) for (let d = 0; d < b.targetCount && a + c + d <= w; d++) {
      losses += choose(w, a) * choose(w - a, c) * choose(w - a - c, d) * 12n ** BigInt(a + c + d);
    }
    return { wins: total - losses, total };
  }
  // State = last pocket and previous strict direction. Equal neighbors are excluded.
  let up = Array<bigint>(37).fill(0n), down = Array<bigint>(37).fill(0n);
  for (let n = 0; n <= 36; n++) { up[n] = BigInt(n); down[n] = BigInt(36 - n); }
  for (let draw = 2; draw < 4; draw++) {
    const nextUp = Array<bigint>(37).fill(0n), nextDown = Array<bigint>(37).fill(0n);
    for (let a = 0; a <= 36; a++) for (let c = 0; c <= 36; c++) { if (c > a) nextUp[c] += down[a]; else if (c < a) nextDown[c] += up[a]; }
    up = nextUp; down = nextDown;
  }
  return { wins: [...up, ...down].reduce((a, n) => a + n, 0n), total };
}
