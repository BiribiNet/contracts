# Arbitrum One deployment reconciliation — 2026-10-15

This records read-only observations at block 515113346. Public launch is not
approved. `deployments/arbitrum-one.json` is a candidate with incomplete handoff
and explorer verification flags; do not change them based on addresses alone.

Observed: all 27 supplied addresses contain code; Engine and SideBet EIP-1967
slots match their supplied implementations. Engine, registry, scheduler, funder,
treasury, referral and BRB vault links match. There is one market: BRB, id 1.
Its vault holds 300,000 BRB; its minimum bet is 1 BRB. The V2 pair contains
2,400,000 BRB and 24,000 native USDC, with the expected V2 factory/router.
These are dated balance observations, not solvency or execution guarantees.

The engine's subscription exists on the documented mainnet coordinator, holds
11.952032734339140742 LINK, and includes the engine consumer. Its request count
is zero. The coordinator address occurs in the engine implementation bytecode;
it is not inferred from an unavailable public coordinator getter.

The supplied worker's `/health` returns `ok: true`, `configured: true`, keeper
mode and chain 42161. Its root returns 404. Health does not prove successful
webhook delivery or a complete live round. The engine was at round 1 with no
pending randomness. No transaction was signed by this reconciliation.

The BRB creation transaction is
`0xb1b840dc8cead7f779f7523e7df3e5069f747016847865b212147c5a20871fb7`
at block 515103224. Registry, engine and scheduler creation receipts succeed;
their hashes and the bank registration receipt are recorded in the manifest.
That BRB deployment block precedes indexed protocol activity and is used as a
conservative common index start. Historical `eth_getCode` bisection was unavailable
on the public RPC; no inferred per-library creation blocks are recorded.

## Remaining evidence

- Verify deployed source/artifact identity and compatible ABIs. Deployed SideBet
  is 20,898 bytes versus 22,197 in the October 10 rehearsal; funder, evaluator,
  authority and several library sizes also differ. This is a revision mismatch
  to reconcile, not proof of a vulnerability or of an incorrect deployment.
- Complete exact-role/owner enumeration and bootstrap handoff, including the
  authorized keeper signer, then attest the manifest flags with evidence.
- Reassess the existing C1 payout-entitlement and C2 randomness-retry findings
  against the actual deployed revision. The dated review does not clear them.
- Verify mainnet service credentials, Goldsky indexing/realtime and the existing
  Vercel project. The connector used for this work did not expose Biribi.
- Complete explicit small-value approval/betting/VRF/settlement/staking/withdrawal
  canaries and reconcile the receipts before promoting the public site.

The release exporter now supports `defaultMarket: "brb"` and
`automation.mode: "keeper"`. Legacy manifests still default to USDC and CRE.
Keeper configuration leaves AutomationReceiver blank and preserves the existing
authority key. It exports TipJar/router/pair metadata and keeps the buy feature
disabled pending executable-route validation. No contracts were upgraded or
redeployed. See the existing MAINNET_RUNBOOK and the frontend cutover document.
