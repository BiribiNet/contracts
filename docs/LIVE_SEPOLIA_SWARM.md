# Live Arbitrum Sepolia swarm

`yarn test:swarm:live-sepolia` runs a separate integration harness against the existing deployment manifest. It defaults to read-only preflight and rejects every network except Arbitrum Sepolia (421614). It does not deploy contracts, simulate VRF, force outcomes, or submit scheduler jobs. Real Chainlink VRF and the existing Goldsky/Cloudflare automation must complete the round.

The default scenario is 250 tickets across 25 deterministic test wallets, each ticket covering all 37 numbers with 1 BRB per number: 9,250 BRB total stakes and 9,250 stored legs. A normal draw returns 9,000 BRB, so the wallets lose 250 BRB in aggregate before any naturally triggered jackpot. This is repeated wagering across 25 EOAs, not 250 simultaneous independent users. Jackpot-specific live coverage depends on real randomness and must be reported rather than assumed.

The signer must have at least 9,250 BRB and the conservative preparation budget of `walletCount × 0.008 + 0.05` test ETH. Preparation tops each wallet up to 370 BRB and 0.008 test ETH for the default ten-ticket allocation and approves exactly 370 BRB. Wallet keys are deterministically derived from secure Hardhat BRB_KEY with a test-specific HMAC domain, are never logged or saved, and must never be used on mainnet. Retain the original secure signer to recover test funds.

An idle round with the existing 60-second duration is required. The harness never changes round duration. It submits ten waves in groups of at most 25 concurrent wallets, with one in-flight transaction per wallet, explicit nonces and receipt confirmation between waves. Every group samples the current gas price and uses twice that price, capped at 0.1 gwei; it does not reuse a stale admission-start price as load raises Arbitrum's base fee. Admission stops if the fee ceiling or safety deadline is exceeded or any transaction fails; this is a test failure, not grounds to extend the window. Confirmed receipts record their actual round, and a round change stops subsequent waves. A pending transaction can still land later, so inspect every submitted hash on interruption; do not blindly retry. Other testnet users can still participate; external tickets are reported rather than silently attributed to the swarm.

## Commands

Use Node 22 and available Sepolia RPCs. Do not put private keys on command lines. Set `ARBITRUM_SEPOLIA_RPC_URLS` to an ordered JSON array or comma/newline-separated list, through the environment or secure Hardhat configuration. For example: `["https://primary.example/rpc","https://backup.example/rpc"]`. The legacy `ARBITRUM_SEPOLIA_RPC_URL` remains supported. Environment configuration takes precedence over saved Hardhat settings, and the plural setting takes precedence within each source. Hardhat uses the first URL to bootstrap the network; the swarm explicitly binds all contract reads, funding, wagering and receipt checks to the complete viem fallback transport. Each endpoint's chain ID is checked before it can serve requests; wrong-chain endpoints fail over. Request errors/timeouts/rate limits try the next URL in order, while contract reverts remain failures. A transaction failover rebroadcasts the same signed bytes; an ambiguous failure still requires journal/nonce reconciliation rather than rerunning a wager. Endpoint URLs are never stored in public reports.

```sh
yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=prepare CONFIRM_LIVE_SWARM=421614:250x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=run CONFIRM_LIVE_SWARM=421614:250x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=observe yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=verify-payments yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=cleanup CONFIRM_LIVE_SWARM=421614:250x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=verify-cleanup yarn test:swarm:live-sepolia
```

The default journal is reports/swarm/live-sepolia-2026-10-10.json, overridable with LIVE_SWARM_JOURNAL. The fixed wallet derivation domain intentionally makes this campaign recoverable; changing the journal does not create fresh wallets. Each wager hash is saved before receipt confirmation. A partial or ambiguous run refuses automatic resubmission: inspect receipts and the pending nonce before proceeding, and preserve the original journal. Never delete evidence to blindly retry.

Observe checks real fulfillment, completed phase, next-round advancement, all 250 confirmed tickets, ordinary payout liability, and wallet accounting on normal draws. Also inspect both automation workflows and indexed round/ledger state. Onchain completion alone does not establish subgraph correctness or Cloudflare workflow success. Snapshot evidence before cleanup; cleanup returns wallet BRB, revokes any remaining allowance, and returns excess test ETH while retaining a conservative small fee reserve. Funding queue processing remains a separate operational step and is not disguised as automatic payout coverage.

## Recorded campaign: 2026-10-10, round 2141

Passed the live ordinary-draw scenario on the current deployed Engine, BRB bank, two payout lanes and replacement queued funder. All 250 tickets across 25 wallets confirmed in 30.588 seconds; first-to-last onchain wager timestamps span 28 seconds. Every receipt belongs to round 2141. The round duration remained 60 seconds throughout; no duration-setting transaction was sent. Real VRF produced winning number 21 and jackpot number 10, so this campaign did not exercise jackpot settlement.

Real oracle transaction: `0xe43541b3f56bed1209c4cb30f8818ce9d7d818aca88f7dccfce903a3245e1fe4`. Automated final settlement transaction: `0x0add36f7df082f70af819c8942319f71ba4dcf5d095b41632fe6a07911d6f877`. Round 2142 opened without manual scheduler intervention. Six payout transactions paid 250 winners across both lanes; maximum scheduler receipt gas was 1,341,689. Maximum wager receipt gas was 3,879,651. Arbitrum receipts include L1-related gas accounting, so these are actual live receipt figures, not exact EVM callback-only measurements.

The 9,250 BRB wager returned 9,000 BRB. The 250 BRB house profit split into 237.5 BRB retained by LPs, 7.5 BRB queued for funding and 5 BRB infrastructure fees. Wallet aggregate change was exactly -250 BRB, bank assets rose exactly 237.5 BRB and bank shares were unchanged. There were no external tickets in this round.

The existing brb Goldsky testnet prod alias (0.1.55) reported CLEAN, winning/jackpot numbers 21/10, correct stakes/payouts, zero failed automation calls, no indexing errors, and BRB bank assets/shares matching onchain. The replacement funder's ledger is not yet indexed by that version; candidate 0.1.56 is rebuilding and must pass separate validation before promotion. The current onchain BRB funding queue was 7.89 BRB, including 0.39 BRB from preceding rounds. This test validates fee queueing, not an ongoing funding keeper.

### Proven worker follow-up

The round-lock workflow and two payout-drain wakes acknowledged cre_accepted, and the contract settled successfully. Five later payout wakes falsely acknowledged vrf_not_fulfilled and notified failure after completion. `src/chain/engine.ts` in cre-automation-starter reads currentGlobalRound instead of the webhook's roundId; after advancement it inspects round 2142, whose VRF is naturally unfulfilled. Fix stale-round handling to recognize completed historical rounds, and ensure stale wakes cannot drain jobs belonging to a newer round. Separately, the workflow currently returns normally after failure acknowledgments, so Cloudflare's Completed label alone is insufficient. No worker deployment was made during this campaign.

Raw public transaction evidence is in live-sepolia-2026-10-10.json, with sanitized indexed-state and workflow-outcome snapshots in the adjacent -index.json and -workflows.json reports. Temporary raw CLI logs and private signing material are excluded from Git.

Cleanup completed and was independently read-verified: all 25 wallets have zero BRB and zero bank allowance, excess test ETH was recovered, and the configured duration remains 60 seconds. Small ETH fee reserves remain in the recoverable test wallets.

## Larger live campaigns

Set LIVE_SWARM_TICKETS and LIVE_SWARM_WALLETS together; the confirmation string must match the ticket count. The runner validates equal ticket allocation and saves a separate default journal named with the ticket/wallet counts. For example:

```sh
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=prepare CONFIRM_LIVE_SWARM=421614:1000x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=run CONFIRM_LIVE_SWARM=421614:1000x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=observe yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=verify-payments yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=cleanup CONFIRM_LIVE_SWARM=421614:1000x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_TICKETS=1000 LIVE_SWARM_WALLETS=100 LIVE_SWARM_MODE=verify-cleanup yarn test:swarm:live-sepolia
```

Preparation now uses a separately derived campaign funding EOA so bulk wallet funding does not contend with the hosted keeper's signer. Funds are seeded once from the configured administrator, then sent in bounded batches with explicit funding-wallet nonces. Wallet approvals and recovery run in bounded parallel batches. All submitted hashes remain journaled. The isolated funding account is recovered during cleanup as well. The configured secure signer remains necessary to rederive both funding and wagering keys; no private keys are saved to reports.

Broadcasts are bounded to 25 wallets per batch; receipt reconciliation runs at most ten requests concurrently with a 1.5-second polling interval. After an interrupted run, use `LIVE_SWARM_MODE=reconcile` with the same campaign counts and journal. This only reads submitted transaction receipts and never resubmits a wager. Then run `observe` to verify settlement for the actual confirmed count. An incomplete campaign remains `partial-submitted` / `partial-settled` with `fullSubmission: false`; cleanup may recover a verified partial campaign without claiming the configured ticket target succeeded. Cleanup verification also checks that the isolated funding wallet has zero BRB.

Before cleanup, run `verify-payments` against the same journal. It compares each wallet's stake transfers and ordinary payout transfers with its confirmed ticket count, checks any treasury jackpot transfers against exact-round `JackpotPayment` logs, and reconciles each final balance at one block. Receipts must contain the expected player, 37 BRB amount, full 37-number calldata and target round. Other transfers remain explicit in the evidence. Use a new `LIVE_SWARM_JOURNAL` path for a new campaign; wallets are reused only after earlier submitted transactions and payments are reconciled.

### Interrupted 1,000-ticket attempt, October 10

Round 2146 contains **100 confirmed campaign tickets**, rather than the 1,000-ticket target. RPC rate limiting interrupted receipt polling after the first wave. The saved payment verification records successful target-round receipts and correct payment for all 100 wallets. The journal's receipts were reread from Sepolia on October 13 and reconciled as `partial-submitted`; this is not evidence of a successful 1,000-ticket campaign or completed wallet cleanup. No further wagers were placed during that reconciliation.

Run the offline accounting and batch-failure regression checks with `node --test -r ts-node/register/transpile-only scripts/live-swarm-evidence.test.ts`, and type-check the runner with `tsc --project tsconfig.live-swarm.json`.

Successful load testing does not establish recovery from missing webhooks, sustained RPC outages, depleted keeper ETH or shared-signer nonce contention. Production needs an independent reconciliation/watchdog path and serialized transaction ownership, and jackpot-specific hosted coverage. The deployed contract cursor checks prevent stale payout chunks from double-paying; an avoidable revert or exhausted workflow is still an operational failure worth detecting.


## Recorded 1,000-ticket campaign: October 13, round 2394

All **1,000 tickets across 100 wallets** confirmed in round **2394**, each covering all 37 numbers with 1 BRB per number: 37,000 BRB in stakes and 37,000 stored legs. Runtime admission/receipt checks took 52.44 seconds; first-to-last mined wager timestamps span **50 seconds**. The existing 60-second betting window stayed unchanged. Every receipt contains the correct wallet, exact stake/calldata and round, with 1,000 unique transaction hashes and ten tickets per wallet. There were no external tickets.

The swarm used viem fallback with two endpoints, preferring the lower-latency Sepolia PublicNode endpoint and retaining the authenticated Biribi Cloudflare gateway. The worker has its independently configured RPC list. An initial October 13 attempt reached 989 tickets before its stale fixed gas price fell below the increasing base fee. All 989 tickets settled and all 100 wallets were correctly paid 35,604 BRB; that partial run is preserved separately. The successful retry refreshes prices per 25-wallet group, uses 2x headroom and a 0.1 gwei fee ceiling. Submitted retry prices ranged from 40,324,000 to 72,344,000 wei.

Real VRF produced **13 / 17**, so this was an ordinary draw, with no jackpot payment. All 100 wallets independently received exactly **360 BRB** for ten tickets and ended at **360 BRB** from a 370 BRB starting balance. Token transfer evidence, target-round jackpot logs and final balances agree for every wallet. Aggregate ordinary payouts equal **36,000 BRB**; the 1,000 BRB net loss is the expected 1 BRB per ticket. Settlement advanced to round 2395 without manual scheduler submissions.

The round finished in **82 seconds** from the first bet: 60 seconds betting plus **22 seconds** to settle, including **18 seconds after VRF fulfillment**. VRF was requested one second after lock. Maximum wager receipt gas was 3,879,651; maximum observed automation receipt gas was 2,040,489. These are live Arbitrum receipt values, including its fee accounting. Resolution transaction: `0x5e25e3f93c7d99830ef50b3649c229275d13c53cf32064070056890e6678d0d7`. VRF transaction: `0xa519e69a4e18692d3c251cd938972930b7a9ba1dba8aed5a946cbf69784e1867`.

Reports: `live-sepolia-2026-10-13-1000x100-retry.json` retains every preparation/wager/recovery hash, observations and per-wallet payment checks. The adjacent summary and workflow reports record timing and hosted automation outcomes. `live-sepolia-2026-10-13-1000x100.json` is the separate verified 989-ticket attempt. No credentials or endpoint URLs are saved in these public artifacts. This ordinary-draw success does not establish a live 1,000-ticket jackpot result or guarantee availability when every RPC fails.


All **20 observed round-lock/payout workflow instances for round 2394 completed successfully**, with no final workflow errors. Payment verification was saved before recovery. Recovery reconciles earlier journaled hashes and uses explicit sequential nonces per wallet, avoiding stale pending-nonce reads between each wallet's token and ETH recovery transactions.


Cleanup completed and was read-verified after this campaign: **all 100 wallets have zero BRB and zero bank allowance**, the isolated funding wallet has zero BRB, and excess test ETH was recovered with small fee reserves left recoverable. The verified onchain admission interval remains 50 seconds and round duration remains 60 seconds.
