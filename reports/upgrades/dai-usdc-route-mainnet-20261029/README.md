# DAI via USDC funder replacement, 29 October 2026

Status: completed and live-verified. The replacement funder is source-verified and active; the original webhook-only keeper is resumed, healthy and has no pending transaction. This report records a funder replacement, not a proxy implementation upgrade.

## Authorization and scope

The owner approved deployment after fork verification and explicitly accepted leaving the old 0.03 DAI behind. The old queue remains backed at its existing address; it is not swept, imported into the replacement, or counted as processed. No extra BRB pair is created and no funds are pulled from any bank vault for migration.

- Old funder: `0xa55e108b9ae4f50b2d63ea94a3d2c48add969e4e`.
- New funder: `0xd0083c4D3056F6D2bb2b98aEB4FEe0DD36C3bDB5`.
- Engine proxy: `0xfc6474d1594952ef5beb779b97ba69198b4e7625`.
- Engine implementation must remain `0xa50F1EF3Ae42D8aCE07d1C0747a33A1C8f030193`.
- DAI -> USDC -> BRB; USDC -> BRB; native BRB distributed directly.
- Infrastructure receives its existing 2% of house profit; the 3% BRB funding slice and 250/300 treasury share are retained.

## Deployment evidence

Activation: `0x32849f48a2a37122fe8b3d78e06f9e50d4362792024f5fd4ad5185f8443132b2`, block 519458900. The receipt emitted only JackpotFunderUpdated; a 64-slot comparison shows only engine storage offset 2 changed. No proxy implementation changed.

`plan.json` contains the exact constructor arguments, expected runtime, source hash, live policy settings, nonce assignments and bounded fees. `journal.json` records the signed transaction hashes and receipts, without serializations or private keys.

- Deploy: `0xcd4d3aa9ec10df463027e45deb202ae1b7d280e758227b37e35d44a29b56baab`, block 519451162.
- Seed both observations: `0x2442f3f58193a1546d5cdb6e9859b3de4625f242515b0477be88026461b49171`, block 519451244.
- Oracle warm-up completes at 2026-10-29 20:07:17 UTC (21:07:17 Paris).
- Source verification passed for the exact compiler input and constructor arguments.

The fresh local rehearsal in `actual-address-fork.json` uses the exact planned creation address, deployment payload, nonces, live policy values and activation payload. It proves that only engine storage offset 2 (`JACKPOT_FUNDER`) changes, while all other captured engine storage and the engine implementation remain unchanged. Real DAI/USDC/BRB pool processing and exact treasury/burn reconciliation passed. The original 71-test regression suite and dedicated TypeScript check also passed.

## Keeper and indexing

The actual deployed keeper is webhook-only, with no cron and one payout lane. Its deployed bundle is preserved. Only its bundled funder address changes; the temporary maintenance flag is used to stop sends during the cutover. The existing Durable Object namespace, secrets, webhook routes, pending-transaction ledger and 1.5M funding gas limit are retained. Patch tests cover both paused phases, preserved pending state, and the exact active settings delta (`worker-patch-tests.json`). Credential-bearing source backups remain private outside this report.

The event mirror adds the new funder alongside the old one and preserves its existing source definitions and authenticated sink. Its post-update state returned to ACTIVE with one ready replica.

Indexer release preparation found that the working-tree source predates production's four append-only SideBet enum values and immutable RoulettePlacement receipts. Those incomplete candidates were never promoted. The corrected candidate uses the saved `origin/master` production source at `5ee1ade`, including the mainnet-specific withdrawal mapping and all production schema features. It retains the old funder, appends the new source at its deployment block and uses native Goldsky grafting from `biribi-arbitrum-one/1.1.0` at block 519451161. Version `1.1.4` is private-only, synchronized and promoted after 61 historical entity collections containing 2,597 records matched production. Same-block vault/share checks show zero introduced drift. The existing production indexed BRB assets exceed the chain value by 2 BRB at the compared block; that baseline discrepancy is recorded in `indexer-reconciliation.json` and is not changed by this release. The Sepolia subgraph and its alias remain untouched.

## Completion gates

1. `indexer-reconciliation.json` reports equal historical records, zero share drift and zero introduced asset drift for all three vaults, then promote only the Arbitrum prod alias.
2. Reconcile the keeper's persisted successful transaction and require no pending nonce. Pause its existing deployed code and install the new address while it remains paused.
3. Wait for the configured TWAP lookback. Recheck live funder policies, bytecode, engine implementation and old queues. Call only `setJackpotFunder(newAddress)` from the existing authorized administrator.
4. Confirm the single pointer-change event, unchanged engine implementation and storage, existing fee policies, backed old DAI residual, and zero unexpected old BRB/USDC liabilities.
5. Resume the same keeper bundle at the new address, wake it and verify health, nonce reconciliation, indexer configuration and the frontend's dynamic funder lookup. Preserve both funders' history and update public deployment metadata.

Rollback restores the old funder pointer and saved keeper configuration after pending-transaction reconciliation. It does not move queues between addresses and reintroduces the old DAI routing limitation. Preserve both ledgers throughout.


## Final checks and remaining configuration follow-up

`live-verification.json` confirms the exact immutable-patched runtime, unchanged engine implementation, DAI -> USDC -> BRB route, warm observations, current policies, balanced per-market ledgers, zero failures on the replacement and cleared token allowances. The final service check confirms that the production indexer sees the new active funder, the mirror is ACTIVE and includes both addresses, and the resumed keeper is healthy in webhook-only mode with one payout lane and no pending transaction.

The active keeper version is `e0f7344b-d0b3-485f-9f15-804e4354dae0`. Only its bundled funder setting changed permanently; no cron, proxy implementation, secret or Durable Object identity changed. The old backed 0.03 DAI remains on the old funder as explicitly accepted by the owner. This rollout did not place a live wager or transfer test funds; the swap and settlement smoke tests ran on the isolated fork with real pool code and state.

The frontend's live funding panels read `RouletteEngine.JACKPOT_FUNDER()` dynamically. Public deployment manifests are updated locally. After Vercel team consent, the existing production-only `NEXT_PUBLIC_JACKPOT_FUNDER_ADDRESS` was updated to `0xd0083c4D3056F6D2bb2b98aEB4FEe0DD36C3bDB5` and verified by reading the same variable ID back. No preview or development variable was edited. No frontend redeployment was needed or performed for the live funder cutover. See `frontend-environment-followup.json`.

A pre-existing 2 BRB excess in indexed `Market.totalAssets` versus the same-block on-chain vault value was found during reconciliation. It is identical in the old and new indexer and has not been silently corrected by this release. All share balances match and all three markets have zero introduced asset drift. See `indexer-reconciliation.json` for exact blocks and amounts.
