/** Reject unknown/failed receipts before using a partial campaign as settlement evidence. */
export function submissionEvidence(report: {
  round: string;
  tickets: number;
  wallets: { bets: { confirmed?: boolean; receiptStatus?: string; actualRound?: string }[] }[];
}) {
  const bets = report.wallets.flatMap((wallet) => wallet.bets);
  if (bets.length === 0) throw Error('No submitted tickets to reconcile');
  if (bets.length > report.tickets) throw Error('Submitted tickets exceed campaign target');
  if (bets.some((bet) => !bet.confirmed || bet.receiptStatus !== 'success' || bet.actualRound !== report.round))
    throw Error('Reconcile every submitted receipt in the target round first');
  return { confirmedTickets: bets.length, fullSubmission: bets.length === report.tickets };
}

/** Wait for every operation in a batch before surfacing a failure; never leave journal writes in flight. */
export async function inBatches<T>(items: T[], size: number, action: (item: T, index: number) => Promise<void>) {
  for (let start = 0; start < items.length; start += size) {
    const results = await Promise.allSettled(
      items.slice(start, start + size).map((item, i) => action(item, start + i)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
