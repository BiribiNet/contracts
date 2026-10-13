import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inBatches, submissionEvidence } from './utils/liveSwarmEvidence';

const receipt = () => ({ confirmed: true, receiptStatus: 'success', actualRound: '2146' });
const report = (submitted = 100, target = 1000) => ({
  round: '2146',
  tickets: target,
  wallets: [{ bets: Array.from({ length: submitted }, receipt) }],
});

test('an interrupted 100-of-1000 campaign remains partial', () => {
  assert.deepEqual(submissionEvidence(report()), { confirmedTickets: 100, fullSubmission: false });
  assert.deepEqual(submissionEvidence(report(1000)), { confirmedTickets: 1000, fullSubmission: true });
});

test('unconfirmed, failed and wrong-round receipts cannot authorize settlement accounting', () => {
  for (const change of [{ confirmed: false }, { receiptStatus: 'reverted' }, { actualRound: '2147' }]) {
    const value = report();
    Object.assign(value.wallets[0].bets[0], change);
    assert.throws(() => submissionEvidence(value), /Reconcile every submitted receipt/);
  }
  assert.throws(() => submissionEvidence(report(0)), /No submitted tickets/);
  assert.throws(() => submissionEvidence(report(1001)), /exceed campaign target/);
});

test('receipt work stays within its batch limit', async () => {
  let running = 0,
    peak = 0,
    completed = 0;
  await inBatches(
    Array.from({ length: 23 }, (_, i) => i),
    10,
    async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      completed++;
    },
  );
  assert.equal(peak, 10);
  assert.equal(completed, 23);
});

test('a failed batch finishes its other journal writes and prevents the next batch', async () => {
  const started: number[] = [],
    finished: number[] = [];
  await assert.rejects(
    inBatches([0, 1, 2, 3], 2, async (i) => {
      started.push(i);
      if (i === 0) throw Error('RPC failure');
      await new Promise((resolve) => setImmediate(resolve));
      finished.push(i);
    }),
    /RPC failure/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, [1]);
});
