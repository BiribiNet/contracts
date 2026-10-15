# Event-indexing upgrade preparation — 15 October 2026

Target: existing Arbitrum Sepolia deployment (421614). No public-network transaction was sent.

## Source comparison

After fetching origin/master, the current checkout `7dc9bb6` is 12 commits behind
remote master `accc387`, with no checkout-only commits. The separate local branch
named master is 27 commits behind remote. The indexed-parameter removal remains
uncommitted in this checkout. No merge, pull, reset, commit or push was performed.

Remote adds bounded jackpot preparation, newer deployment/recovery checks, and
four new side-bet rules. The deployed engine, BankVault and active funder's main
Solidity source files match current remote master. The checkout predates the
bounded jackpot fix: do not deploy its engine/library artifacts to this deployment.

The local deployment manifest is stale: current engine implementation is
`0x4FFDD949820B8Cb358ab64985B436Cc8Dd4F68E8`; the active funder is
`0x16aBfAB1E1c18C895EdCE0d6b8125AB451502fd3`. Queued funding is already live.

## Prepared candidate

Explorer-verified deployed source inputs were recompiled with Solidity 0.8.27.
Only protocol event indexed qualifiers were removed. Dependency standards were
preserved. The compiler storage layouts are identical, and ABIs differ only in
indexing flags. Runtime sizes fit EIP-170. Six candidate modules and all required
engine library dependencies are saved alongside this report.

Pinned fork: block 319378473, hash `0x95af9d8aaf2bd5ea49efb1f77515171bbd5cd0ebce59b3d8dcd54847c0909654`. Every original target and
linked library runtime was checked against recompiled verified sources.
The rehearsal deployed candidates and upgraded the existing engine proxy and
vault beacon locally. Bank assets, shares, locks, market IDs and SideBet controllers,
engine round/VRF/wiring, and protocol immutables were preserved. OpenZeppelin's
implementation self-address immutable correctly changed to the new implementation.
Replacements were deployed only on the fork and were not activated there.
No end-to-end post-upgrade betting or payout lifecycle has been certified by this
rehearsal; the prior 77 contract tests cover local-master builds, not these exact
verified-source candidate outputs.

## Activation work remaining

- Finalize the release scope. Recommendation: event-layout changes to currently
  deployed versions, preserving existing jackpot fixes and fee behavior. Newly
  merged side-bet features require their own release decision.
- Prepare historical/new event decoding boundaries for the subgraph, Turbo and
  frontend before any public upgrade. A plain ABI replacement loses old decoding.
- Preserve the active funder's 98.55 BRB queue. It is reserved input, not a free
  sweep balance; retain the old service until reconciled or rehearse an explicit
  processing/migration procedure. No queued funds were moved or processed.
- Capture all current authority approvals, receiver allowlists and policy settings
  before activating replacement modules. The manifest receiver is currently NOT
  approved; the operator is approved. Do not reinstate an obsolete executor.
- CRE credentials returned 403 Forbidden on a read-only workflow-list request.
  Renew authentication before changing workflow receiver routing.

Evidence: `live-state.json`, `build-summary.json`, `fork-rehearsal.json`, and the
per-module verified sources/compiler inputs/outputs in this directory.
