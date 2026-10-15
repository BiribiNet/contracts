export interface EconomicsInput {
  probability: number;
  multiplierBps: number;
  stake: bigint;
  tickets: number;
  seed: number;
  feeBps: bigint;
  batchSize?: number;
}

/** Model only: independent tickets, fixed payout, no expiry, no gas and no roulette liability.
 * Correlated tickets require the all-win reserve stress below, not the sampled loss quantile. */
export function simulateSideBetEconomics(input: EconomicsInput) {
  const { probability: p, multiplierBps, stake, tickets, feeBps, batchSize = 100 } = input;
  if (!(p > 0 && p < 1) || !Number.isInteger(multiplierBps) || multiplierBps < 10000
    || stake <= 0n || !Number.isInteger(tickets) || tickets < 1 || tickets > 1_000_000
    || feeBps < 0n || feeBps > 10000n || !Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid economic scenario');
  let seed = (input.seed >>> 0) || 1;
  const payout = stake * BigInt(multiplierBps) / 10000n;
  const lossFee = stake * feeBps / 10000n;
  let paid = 0n, ticketFees = 0n, batchFees = 0n, wins = 0;
  let balance = 0n, peak = 0n, maxDrawdown = 0n, batchProfit = 0n;
  for (let i = 0; i < tickets; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const won = (seed >>> 0) / 4294967296 < p;
    const returned = won ? payout : 0n;
    if (won) wins++;
    paid += returned;
    const fee = won ? 0n : lossFee;
    ticketFees += fee;
    batchProfit += stake - returned;
    balance += stake - returned - fee;
    if (balance > peak) peak = balance;
    if (peak - balance > maxDrawdown) maxDrawdown = peak - balance;
    if ((i + 1) % batchSize === 0 || i + 1 === tickets) {
      if (batchProfit > 0n) batchFees += batchProfit * feeBps / 10000n;
      batchProfit = 0n;
    }
  }
  const stakes = stake * BigInt(tickets);
  const gross = stakes - paid;
  const lifetimeFees = gross > 0n ? gross * feeBps / 10000n : 0n;
  // Expectation includes the actual integer payout/fee for the selected stake units.
  const expectedNetStakeFraction = 1 - p * Number(payout) / Number(stake)
    - (1 - p) * Number(lossFee) / Number(stake);
  return { tickets, wins, stake: stake.toString(), payout: payout.toString(),
    expectedNetStakeFraction, stakes: stakes.toString(), paid: paid.toString(),
    ticketPolicy: { fees: ticketFees.toString(), lpNet: (gross - ticketFees).toString() },
    batchPolicy: { fees: batchFees.toString(), lpNet: (gross - batchFees).toString(), batchSize },
    lifetimePolicy: { fees: lifetimeFees.toString(), lpNet: (gross - lifetimeFees).toString() },
    sampleMaxDrawdown: maxDrawdown.toString(),
    allWinAdditionalReserve: ((payout - stake) * BigInt(tickets)).toString() };
}
