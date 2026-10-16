# Current reconciliation — 2026-10-16

The dated observations below are retained as history. The canonical manifest now
preserves the locally executed deployment and its verified three-market catalog:
BRB market 1, USDC market 2, DAI market 3. All 28 protocol contract sources are
verified, all five proxies have confirmed implementation ABI links, and the full
on-chain audit passes 138 checks. USDC/DAI banks start unfunded. The Cloudflare
keeper is healthy and watches markets [1,2,3]. No CRE receiver is deployed.
On October 16, both existing Goldsky countdown/payout pipelines were switched to
Arbitrum One and authenticated wake-up routes on the mainnet keeper. They share
the existing durable signer; five-second polling remains independent of Goldsky.

Local and origin/master diverged from commit 751b796: three local execution/fix
commits and four remote observation/cutover commits. Both describe the same engine.
The merge keeps the local verified runtime/source, signer and receipt records,
three-market catalog, and completed handoff/source flags. It retains remote release
export tooling and historical role/creation evidence. The earlier candidate flags,
one-market description and source-mismatch concerns below are superseded by the
exact runtime and constructor audit and explorer verification already recorded in
`deployments/arbitrum-one-onchain-audit.json` and the release reports.

Public launch approval and a signed full betting/VRF lifecycle are separate from
source verification. No additional on-chain deployment or upgrade was performed
for this Git reconciliation.

---

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

## Follow-up — 2026-10-16

At block 515317976 the 21 named roles across eight protocol contracts were
reconstructed from RoleGranted/RoleRevoked logs and checked with hasRole.
The examined memberships match the candidate, without additional holders in
those roles. Scheduler authority, vault beacon implementation/owner and keeper
executor approval also match. The public snapshot is recorded in
`deployments/arbitrum-one-role-audit-2026-10-16.json`. This is a dated role
observation, not completion of bootstrap handoff or deployed source verification.

The approved executor is `0x29984d0c50ddaa5be680b750025dc88d16c57ab8`.
It does not prove which signing key the deployed Worker uses. Transaction
`0x5fc3f1989b76ceb7106b2cb8bf7b79f4b1d3ab4b87889eb676d34d3feffd7529`
at block 515103432 emits `ExecutorApprovalUpdated(address,bool)` with one
topic (the event signature) and both arguments in data. The repository event
declares the executor indexed. The candidate explicitly records
`automation.executorApprovalIndexed: false`; isolated mainnet indexer/decoder
generation must honor that evidence. Solidity and shared testnet ABIs have
not been rewritten to imply that the deployed revision equals current source.
Other deployed event layouts still need reconciliation.

Vercel now exposes the existing frontend project and accepts isolated Preview
settings. The public site remains Sepolia. Independent mainnet service
credentials, shared API security storage, deployed source identity, the C1/C2
review and signed lifecycle canaries remain release gates. Both completion
flags intentionally remain false.
