# Mainnet follow-up — 2026-10-10

**Keep public launch on hold.** The requested stress test exposed a reproducible jackpot gas failure, which is now fixed and retested. A pinned Arbitrum fork rehearsal and frontend hardening also pass. C1 payout entitlement, C2 randomness recovery, remaining dependency exceptions and real service provisioning still require release decisions or work.

User decisions: test C3 first and fix proven failures; retain external libraries for bytecode size; EOA administration initially, Safe later; preserve the existing hosting structure and Sepolia environment. No mainnet transactions, Goldsky operations, cloud deployments or DNS changes were made. Fork transactions ran only on local chain 31337.

## C3: measured failure and bounded repair

Each ticket places **1 BRB on every number 0–36** (37 BRB total). Four cases use 250 or 1,000 repeated tickets, rotating through 127 wallets, with and without a jackpot: **2,500 tickets / 92,500 stored bet legs** in the repaired runs. These are real local contract transactions and storage, not fabricated arrays. The callback uses Chainlink's exact-gas call implementation with a 2,500,000 gas limit; each settlement transaction has the same limit. Tests verify every player's final balance and the drained jackpot pool.

Before repair, both jackpot cases exhausted the first settlement transaction's gas. Normal rounds and all callbacks succeeded. Baseline evidence is in `reports/swarm/baseline/`.

The repair moves jackpot eligibility collection into batches of at most 32 steps and caches player/stake rows once. Payout previews consume bounded cached slices instead of rescanning every winning ticket on every settlement call. New namespaced storage is appended; a compiler-AST regression test protects every previous field/type and the original layout prefix. Small existing rounds preserve their established settlement behavior. The CRE job ABI is unchanged.

| Case | Callback gas | Largest settlement gas | Settlement calls | Result |
| --- | ---: | ---: | ---: | --- |
| 250 tickets, normal | 450,302 | 836,757 | 10 | Pass |
| 250 tickets, jackpot | 450,532 | 2,147,893 | 25 | Pass |
| 1,000 tickets, normal | 578,552 | 1,104,035 | 20 | Pass |
| 1,000 tickets, jackpot | 578,782 | 2,098,612 | 82 | Pass |

Reports: `reports/swarm/*.json`. Repeat with Node 22:

```sh
yarn test:swarm
```

This establishes the tested capacity, not an unlimited guarantee. Callback winner collection still grows with bucket length. Larger rounds, several simultaneously busy markets, other bet mixes, Arbitrum execution fees and hosted CRE cadence need additional capacity testing before increasing production limits. Jackpot preparation now takes multiple keeper calls; operators must monitor progress and budget those calls. The test's large seeded bank is not a production bankroll recommendation.

## O1 and C4: fork and artifact evidence

`reports/fork/arbitrum-one.json` records a passing rehearsal at Arbitrum One block **513332057**. Run it again before deployment against a credential-secured archival RPC:

```sh
ARBITRUM_FORK_BLOCK=513332057 yarn test:fork:arbitrum
```

`ARBITRUM_FORK_URL` can select the source; the existing secure Hardhat RPC setting or the public Arbitrum endpoint is the fallback. Upstream access is read-only. The test refuses local writes unless the network is Hardhat with chain ID 31337 and verifies source chain 42161. Keep raw RPC diagnostics private because providers can include credential-bearing URLs in errors.

The rehearsal deploys the protocol with size limits enabled; checks native USDC, DAI and LINK decimals; registers three markets; creates a real Uniswap V2 BRB/USDC pair; accepts a request through the real VRF coordinator; settles USDC bets; drains the funding queue through a real V2 swap; and preserves vault shares/bank identity through a beacon upgrade. It also caught and corrected the mainnet native-USDC default address and DAI checksum in the deployment script. USDC is checked against [Circle's official addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).

The local fixture mints USDC and borrows LINK by impersonation, uses a mock scheduler authority and simulates callback delivery. It does not prove real subscription solvency, oracle proof/fee delivery, hosted CRE ownership, engine/SideBet state-preserving upgrades or live service permissions. Hardhat does not reproduce the Arbitrum sequencer and L1 fee accounting. DAI is registered/read-checked, not wagered. Those limits remain in the report.

Keeping external libraries for C4 is appropriate: the final Engine runtime is **22,379 / 24,576 bytes**, SideBet 22,197, vault 15,094 and funder 16,656. All 25 checked production artifacts pass runtime and init-code limits. The appended layout guard supplements OpenZeppelin's incomplete validation of external namespaced storage; it does not replace a full upgrade rehearsal for every storage system.

CI runs the swarm independently. A manual `mainnet-rehearsal` environment job runs the fork with a private RPC secret and uploads only sanitized JSON evidence. Configure the environment's approval/access rules in GitHub before using release credentials.

## F1 and F2: frontend changes and limits

Next is updated from 16.1.6 to 16.4.0, with matching lint config; React/DOM to 19.2.8, next-intl to 4.14.9 and Supabase to 2.117.3. Compatible transitive fixes reduce the production audit from 107 to **eight unique advisories (two high, six moderate)**. Exceptions and reachability are recorded in `frontend/docs/mainnet-security.md` and `frontend/reports/security/dependencies-2026-10-10.json`. They are not a clean audit or a claim that the frontend cannot be attacked.

**Apply and verify the announced October 14 Next security release before launch.** The [official October 8 notice](https://nextjs.org/blog/upcoming-nextjs-security-update-october-2026) announces two critical and one high issue with details/patches forthcoming. Installed 16.4.0 cannot be counted as remediation for an unreleased patch. Re-audit and rerun the production browser/build checks after updating.

HTML now uses fresh nonce CSP with `strict-dynamic`, without production script `unsafe-inline`/`unsafe-eval`; responses are private/no-store. GTM is disabled on mainnet unless explicitly reviewed and enabled server-side. Same-origin checks reject protocol downgrades and malformed origins. Expensive public GraphQL/Ably/contact/newsletter routes use atomic shared Redis rate limits, and verified Ably signature nonces have shared one-use claims. Mainnet fails closed without the shared security store. Origin headers remain a browser boundary, not authentication.

Real disposable Chrome verified nonce rotation, actual blocking of parser-inserted scripts, event handlers and eval, hydration without initial CSP violations, and opening the wallet picker. No wallet signatures or transactions were made. Full connected-wallet approval/betting/withdrawal journeys still require a canary. See `frontend/reports/security/browser-smoke.json`.

Verification: **455 contract tests passed, nine pending** in the default suite (including opt-in swarm/fork cases run separately); swarm four cases passed; fork one passed; frontend **3,955 tests passed**; typecheck and optimized webpack build passed. Lint has zero errors and **58 warnings**: new React Compiler diagnostics in existing files are scoped to warnings; they were not all repaired. New files retain the recommended lint errors. Prior subgraph/worker results remain in the original dated review; these follow-up changes did not alter their code.

## C1, C2 and O2 recommendations

**C1 should stay open.** The authorized CRE workflow can choose wrong payout recipients while remaining within total liability caps. Dedicated owner binding reduces who can submit; it does not prove entitlement. Keep the existing behavior for this change as requested, but before public funds either implement/review entitlement verification or explicitly accept and disclose the workflow's custody-level trust. The jackpot batching fix does not solve C1. C2's ability to discard an outstanding randomness request also remains unresolved; do not use re-requesting as an operational recovery shortcut.

**O2 should use the existing separate funding keeper.** The fork demonstrated successful real-router queue draining. Start it read-only, verify pairs/quotes and queue state, then enable it under supervision with a separate minimally funded signer. Do not add AMM execution to the winner settlement transaction. Chain/confirmation guards are now explicit:

```sh
# Use secure Hardhat RPC/signer configuration; FUNDER_ADDRESS comes from the manifest.
FUNDING_EXPECTED_CHAIN_ID=42161 yarn hardhat run scripts/runFundingKeeper.ts --network arbitrum

# Only after reviewing quotes, observations and live configuration:
FUNDING_EXPECTED_CHAIN_ID=42161 FUNDING_APPLY=true CONFIRM_MAINNET_FUNDING=arbitrum-one:42161 FUNDING_KEEPER_CYCLES=1440 yarn hardhat run scripts/runFundingKeeper.ts --network arbitrum
```

The second command runs up to a day of minute-spaced cycles; supervise/restart it and alert on unexpected exit, five-failure stops, queue growth/age, missing observations, pending treasury/burn debts and low signer ETH. Queue age must come from first-queued event time; the funding account's credited field is not a timestamp. Monitor receipts/readbacks and avoid retrying uncertain transactions blindly. More than 100 markets require reviewed `AFTER_MARKET_ID` coverage.

O3 was not reopened for a broad toolchain upgrade. The original toolchain audit and secret/history/account-permission limits remain recorded; this follow-up does not mark them cleared.

## Concrete remaining release sequence

1. Resolve/accept C1 and resolve C2; apply the October 14 security patch and review the eight dependency exceptions.
2. Freeze revisions and rerun the pinned fork/swarm with final settings; rehearse engine/SideBet upgrades and hosted CRE metadata/cadence. Complete bankroll, LINK and gas budgets.
3. Follow `MAINNET_RUNBOOK.md`: read-only preflight, deliberate deployment confirmation, receipt/role/code verification, isolated workflows and funding keeper, staged index reconciliation, then canary.
4. Keep the current Vercel project. Bind a persistent Sepolia Preview branch/build to **testnet.biribi.net**, with branch-scoped testnet secrets and indexing disabled. Production is a separate mainnet build for biribi.net. DNS/account configuration is prepared in the runbook and has not been applied.
5. Provision mainnet shared Redis security credentials and independently scoped service secrets. Every Goldsky operation must first verify **brb**, project `project_cmfbfxud380il01v04gey3ym6`; use the guarded scripts and preserve testnet `biribi/prod`.
