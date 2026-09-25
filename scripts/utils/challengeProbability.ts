/** Exact counts of equally likely, independent 0..36 sequences. Winning states absorb
 * all later outcomes; a duel lost to the other colour can never become a win. */
export function exactChallengeProbability(kind: string, w: number, target = 0) {
  if (!['PASSPORT','COLLECTION','DUEL','BOOMERANG','MIRROR','NEIGHBORS'].includes(kind)) throw new Error('Unknown challenge');
  if (!Number.isInteger(w) || w < 1 || w > 64) throw new Error('Window must be 1..64');
  if ((kind === 'COLLECTION' || kind === 'DUEL') && (!Number.isInteger(target) || target < 1 || target > Math.min(w, kind === 'COLLECTION' ? 37 : 64))) throw new Error('Invalid target');
  let states = new Map<string, bigint>([['', 1n]]),
    won = 0n;
  for (let step = 0; step < w; step++) {
    const next = new Map<string, bigint>();
    won *= 37n;
    const put = (k: string, v: bigint) => next.set(k, (next.get(k) || 0n) + v);
    for (const [key, count] of states) {
      if (kind === 'PASSPORT') {
        const mask = Number(key || 0);
        for (const [g, weight] of [
          [0, 1],
          [1, 12],
          [2, 12],
          [3, 12],
        ]) {
          const m = g ? mask | (1 << g) : mask;
          if (m === 14) won += count * BigInt(weight);
          else put(String(m), count * BigInt(weight));
        }
      } else if (kind === 'COLLECTION') {
        const k = Number(key || 0);
        put(String(k), count * BigInt(k));
        if (k + 1 >= target) won += count * BigInt(37 - k);
        else put(String(k + 1), count * BigInt(37 - k));
      } else if (kind === 'DUEL') {
        const [a, b] = (key || '0,0').split(',').map(Number);
        put(key || '0,0', count);
        if (a + 1 >= target) won += count * 18n;
        else put(a + 1 + ',' + b, count * 18n);
        if (b + 1 < target) put(a + ',' + (b + 1), count * 18n);
      } else if (kind === 'BOOMERANG') {
        if (step === 0) put('E', count * 37n);
        else if (key === 'E') {
          put('E', count);
          put('D', count * 36n);
        } else {
          won += count;
          put('E', count);
          put('D', count * 35n);
        }
      } else {
        if (step === 0) put('', count * 37n);
        else {
          const ways = kind === 'MIRROR' ? 1n : 2n;
          won += count * ways;
          put('', count * (37n - ways));
        }
      }
    }
    states = next;
  }
  return { wins: won, total: 37n ** BigInt(w) };
}
