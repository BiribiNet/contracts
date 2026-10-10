# Live Arbitrum Sepolia swarm

`yarn test:swarm:live-sepolia` runs a separate integration harness against the existing deployment manifest. It defaults to read-only preflight and rejects every network except Arbitrum Sepolia (421614). It does not deploy contracts, simulate VRF, force outcomes, or submit scheduler jobs. Real Chainlink VRF and the existing Goldsky/Cloudflare automation must complete the round.

The fixed scenario is 250 tickets across 25 deterministic test wallets, each ticket covering all 37 numbers with 1 BRB per number: 9,250 BRB total stakes and 9,250 stored legs. A normal draw returns 9,000 BRB, so the wallets lose 250 BRB in aggregate before any naturally triggered jackpot. This is repeated wagering across 25 EOAs, not 250 simultaneous independent users. Jackpot-specific live coverage depends on real randomness and must be reported rather than assumed.

The signer must have at least 9,250 BRB and 0.15 test ETH. Preparation sends 370 BRB and 0.004 test ETH per wallet and approves exactly 370 BRB. Wallet keys are deterministically derived from secure Hardhat BRB_KEY with a test-specific HMAC domain, are never logged or saved, and must never be used on mainnet. Retain the original secure signer to recover test funds.

An idle round with the existing 60-second duration is required. The harness never changes round duration. It submits ten waves of 25 concurrent wallets, with one in-flight transaction per wallet, explicit nonces, a bounded gas price and receipt confirmation between waves. Admission stops if the safety deadline is exceeded or any transaction fails; this is a test failure, not grounds to extend the window. Confirmed receipts record their actual round, and a round change stops subsequent waves. A pending transaction can still land later, so inspect every submitted hash on interruption; do not blindly retry. Other testnet users can still participate; external tickets are reported rather than silently attributed to the swarm.

## Commands

Use Node 22 and an available Sepolia RPC. Do not put private keys on command lines. Set ARBITRUM_SEPOLIA_RPC_URL through the environment or secure Hardhat configuration.

```sh
yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=prepare CONFIRM_LIVE_SWARM=421614:250x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=run CONFIRM_LIVE_SWARM=421614:250x37x1BRB yarn test:swarm:live-sepolia
LIVE_SWARM_MODE=observe yarn test:swarm:live-sepolia
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
