# X100 side-bet range

Four families target a 5% player-facing theoretical house edge, assuming independent,
uniform global roulette draws on 0..36. This is a configuration addition using existing
enum IDs 0, 1, 2 and 6; no Solidity/storage/ABI or subgraph schema change is required.
Prepared code is not evidence of live deployment or activation.

| Family        | Rule                                                                  | Choices per market | Window | Gross multiplier |
| ------------- | --------------------------------------------------------------------- | ------------------ | ------ | ---------------- |
| Perfect Dozen | Chosen dozen on every draw                                            | Dozens 1, 2, 3     | 4      | 85.8628x         |
| Double Number | Chosen number at least twice; hits may be separated                   | 0..36              | 6      | 93.2205x         |
| Seven Streak  | Seven consecutive results of the chosen colour anywhere in the window | Red, black         | 8      | 97.3289x         |
| Nine of Ten   | Chosen colour at least nine times, including ten                      | Red, black         | 10     | 110.7197x        |

There are 44 distinct configurations per market. Zero belongs to no colour/dozen and
breaks a colour streak; it can be chosen as a Double Number target. Windows start at
the next unresolved global round selected by placeBet, not at wall-clock time. Normal
early-win, impossible-dozen-loss and timeout-refund rules remain in effect.

## Exact pricing

`scripts/utils/sideBetX100Catalogue.ts` is the pricing source. Use bigint counts of
equally likely sequences, not Monte Carlo probabilities or floating-point payouts.
The 5% target is 500 basis points of stake:

`multiplierBps = floor(9500 * totalSequences / winningSequences)`

For q = 18/37 and r = 1/37, the independent closed forms are:

- Perfect Dozen: (12/37)^4.
- Double Number: 1 - (36/37)^6 - 6*(1/37)*(36/37)^5.
- Seven Streak: 2\*q^7 - q^8. The subtraction counts the overlapping winning windows only once.
- Nine of Ten: 10*q^9*(19/37) + q^10.

Multiplier rounding increases the edge by less than 0.0002 percentage point for every
offer. `assertX100Pricing` enforces this with rational integer comparisons before seeding.
The JSON pricing report retains exact winning/total counts. Token payouts also floor
`stakeRaw * multiplierBps / 10000`; their extra edge is less than `p/stakeRaw` as a
fraction of stake. Very small raw stakes can therefore exceed the multiplier-only tolerance.
The seed now raises the raw-token minimum when necessary so the combined multiplier/payout
rounding stays within 0.0002 percentage point above 5% at every permitted stake. The frontend
also applies that floor before signing; the on-chain limits must be activated to enforce it
for other clients. Existing higher minima are preserved.
The house edge excludes gas and describes decided win/loss tickets; expired tickets refund
their stake. Protocol fee distribution comes from vault accounting, not a second deduction
from the promised player payout. Review vault returns separately from the player edge.

## Frontend and indexer

`yarn export:x100` writes docs/side-bet-x100-pricing.json and the sibling frontend's
lib/side-bet/x100-catalogue.json. `yarn check:x100` fails if either copy differs.
The frontend shows names/chance disclosures only for real configs matching the full
approved rule and multiplier, and uses cursor paging to avoid the indexer's 100-row
default hiding choices across markets. Existing arbitrary configs keep their generic labels.
All nine locales retain the exact four-decimal multiplier and clarify at-least/zero rules.

The subgraph already reads targetNumber, targetCount, colour, window and multiplier from
getConfig on ConfigAdded/Updated/StakeLimitsUpdated, and snapshots placed-ticket rules.
IDs remain dynamic; do not hardcode config IDs or infer a live catalogue from this file.

## Review and activation

1. Run the X100/catalogue/vault regression tests and frontend tests/typecheck. Run
   `yarn check:x100` with the sibling frontend checkout present.
2. Deploy the compatible frontend before offering the new configs. Inspect the actual
   Sepolia proxy implementation, settlement formats, timeout, VRF state and band with
   the existing read-only preflight. The new range fits the default 5x–500x band.
3. Preview `yarn seed:side-bets:x100:arbitrum-sepolia` (dry run). It uses the existing
   deployment JSON/explicit SIDE_BET_ADDRESS, requires chain 421614 and prints all market
   choices and liquidity-based limits. It fails closed on bad pricing or an unknown catalogue.
4. Optional staging: set SEED_APPLY=true and SEED_STAGE_ONLY=true to add missing configs
   with zero limits. Only SIDE_BET_CONFIG_ROLE is needed; this does not close existing configs.
5. For reviewed market liquidity and limits, set SEED_APPLY=true with SEED_STAGE_ONLY=false.
   Activation requires both config/limits roles, healthy compatible settlement, and sufficient
   available liquidity. SEED_MIN_STAKE_UNITS defaults to 1 asset unit; SEED_SAFETY_BPS defaults
   to 2000 (20% free-liquidity budget per maximum ticket). Review aggregate exposure: this cap
   is per ticket, not a promise that 44 maximum-size tickets can coexist.
6. Check real on-chain configs and indexed choices for every market; place minimal
   test-token tickets and verify outcomes, player transfers and released reserves.

Reruns match every configuration field, retain a stricter existing minimum and never raise
an existing active maximum. They may raise an unsafe minimum or lower a maximum to current
capacity. The X100 command does not retire old configs; open tickets are never repriced.

## Exact repricing of the nine historical offers

`sideBetCatalogue.ts` retains the historical rules/prices and derives replacement prices
with `sideBetEconomics.ts`, using exact integer counts rather than simulation. See
`side-bet-legacy-pricing.json` for old/new multipliers, rational probabilities and raw-token
minima. Legacy rules need a 0.002 percentage point tolerance because their higher winning
probability amplifies the contract's four-decimal multiplier rounding. This is a 5% target,
not an assertion of mathematically identical margins. X100 retains its tighter tolerance.

Preview `yarn reprice:side-bets:arbitrum-sepolia`. This is read-only by default and requires
the same settlement/network preflight as X100. `SEED_APPLY=true SEED_STAGE_ONLY=true` creates
closed replacements only. With reviewed liquidity/limits, `SEED_APPLY=true` activates each
replacement before retiring known historical configs with identical rules. Both role checks
precede any write. Current replacement and historical rules are reread before retirement;
custom prices are untouched. Insufficient capacity leaves the historical offer in place and
reports the skipped replacement. Rerunning after interruption resumes without duplicate prices.

Ticket payouts/rules were snapshotted at placement; retirement blocks new tickets on old IDs
while their existing tickets still settle for the original promised payout. No proxy upgrade,
storage change or subgraph migration is required. These scripts are prepared, not executed.

Run `yarn export:side-bet-economics` after changing the shared math; it copies the pure source
and a SHA-256 fingerprint to the sibling frontend. Both repositories test that fingerprint.
Regenerate the legacy report with `yarn ts-node scripts/exportLegacySideBetPricing.ts`.

The frontend admin audit reads configurations, reservations and recent tickets at one chain
block. It scans at most 1,000 config IDs and 500 newest tickets in batches of 50, with manual
refresh and no new polling loop. Market reserves remain available even when family exposure
is unknown; family exposure is shown only after a complete scan reconciles with `reservedOf`.
Amounts remain separated by market asset. The audit flags prices/minima outside policy and
reports capacity as an upper bound for one additional ticket, not a funding guarantee.
