# Distribution v2: queues, execution and reconciliation

This change depends on distribution contract PRs 39–43. It changes funding timing;
it does not change player payouts or the per-ticket fee policy.
Queued fees are not spendable jackpot balance: they become available only after
the worker actually transfers BRB. A jackpot triggered before that transfer uses
the treasury's existing balance. Frontend estimates must not include the queue.

## Six lots

1. `fundingAccounts[marketId]` credits the exact transferred input. Markets sharing
   one token retain independent queues; `queuedAssetTotals` reserves their sum.
   A market ID is bound to its first asset. Asset migrations require a new funder.
2. Roulette and SideBet settlement call `queueFunding` after `transferOut`.
   Queue bookkeeping performs no token, approval, router or oracle calls.
   The collector and funder are trusted protocol contracts; supported inputs must
   be standard ERC20s without transfer fees or rebasing. Queue credits assume the
   transfer and credit happen atomically in that collector transaction.
3. `analyzeSideBetEconomics.ts` compares per-ticket, per-batch and lifetime-net fees
   for USDC/DAI/BRB and legacy/X100 offers. Outputs remain raw asset units.
   The X100 manifest is copied from frontend `lib/side-bet/x100-catalogue.json`;
   update it when an approved offer changes. Legacy probabilities are sampled
   catalogue estimates. None of the simulations activates or changes an offer.
4. The permissionless worker limits each non-BRB swap to 1% of input reserves
   (admin range 0–5%, with zero rejected). A missing/empty pair keeps funds queued;
   it does not bypass the cap via a router quote. Observations can be sampled
   independently of successful swaps. Native BRB needs no swap.
5. One self-call isolates token getters, approvals, swaps and distribution behind
   a 500,000-gas boundary. A failed self-call rolls all its mutations back. Each
   vault has a 60-second cooldown and stops after five consecutive failed attempts.
   Underfunded outer calls revert before consuming a retry. A partial successful
   chunk resets swap failures unless a BRB liability remains. Only an admin can
   reset stopped attempts. Up to ten markets may be processed in one batch.
6. `FundingReconciled` publishes cumulative inputs and outputs separately, and
   immutable snapshots let the indexer/UI recompute both identities:

   `credited = processed + queued`

   `brbProduced = treasuryPaid + burned + pendingTreasury + pendingBurn`

The split for still-unconverted input uses the parameters at execution time.
Already-created BRB liabilities keep their original treasury/burn amounts.
Sweeps exclude queued inputs and pending BRB liabilities. Legacy `fundFromMarket`
remains collector-only for old integrations, credits only unassigned balances,
and uses the previous synchronous quote path. New collectors never call it.

## Worker operation

`FUNDER_ADDRESS` is mandatory. The worker checks it against the engine's active
funder, inspects up to 100 markets (`AFTER_MARKET_ID` pages larger registries), and
warms each unique asset observation. Reads fail visibly; stopped queues are logged.

Run `yarn hardhat run scripts/runFundingKeeper.ts --network arbitrumsepolia`.
Default mode is a one-cycle read-only report. Set `FUNDING_APPLY=true` only for
execution with the operator's configured signer. `FUNDING_KEEPER_CYCLES=1440`
repeats once per minute for up to a day; use the existing operator service to
supervise/restart it. Graceful signals stop after the current cycle. No keeper
service, credential or deployment is installed by this PR.

## Economic interpretation

Generate the reproducible report with
`yarn hardhat run scripts/analyzeSideBetEconomics.ts`.
For an illustrative 100x gross return and 0.95% win probability, the expected
house edge is 5%. Charging 5% on losing tickets leaves only 0.0475% of stakes
as expected LP net before gas/other costs. This is why ticket fees need an
economic review rather than merely a batch-invariance test.

Samples assume independent fixed-size tickets with no expiry, gas or price
conversion. A sampled drawdown is not a capital guarantee. The all-win reserve
stress captures shared-outcome correlation; add the open roulette liability
before choosing actual stake limits. Reports are hypothetical, not live vault
performance. USDC, DAI and BRB values are never summed together.

## Release and migration

Deploy a replacement non-upgradeable funder with the current engine, SideBet,
BRB, router and treasury. Upgrade collector implementations and activate this
funder together: new collectors require `queueFunding` on their configured target.
Do not activate a new collector against an old funder lacking this selector.
Finish or pause the operator workflow during the cutover; verify player settlement
and funder configuration on the target chain before resuming.

Drain old pending BRB liabilities on the old funder using `retryPendingBrb`.
Do not import those amounts as fresh input: that would change their split.
Reconcile old retained input by vault before migration. Transfer verified input
to the new funder, then use admin `importFunding` with exact market/asset/amount
and a nonzero source transaction hash. It checks unassigned token backing and
emits `FundingImported`; the supplied hash is an audit reference, not a verified
proof by the contract. Preserve source receipts for review. Never infer old
per-vault attribution from a shared raw token balance alone.

Update the indexer's funder source address/start block; preserve historical
sources if their outstanding distributions can still emit events. Reindex the
schema before shipping the new frontend query. Start the worker only after
confirming balances, reserve cap, retry controls and observation warm-up.

No deployment, live transaction, parameter change or background service is
performed by the implementation task.
