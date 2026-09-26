# Eight additional BRBGAME offers

This change prepares code and pricing; it is not evidence of a live Sepolia upgrade.
IDs 0–14, struct storage and settlement APIs remain unchanged. The immutable evaluator
validates challenge configs and evaluates new IDs 15–20. Existing rule validation is
preserved while keeping SideBet runtime within EIP-170.

The eight offers are Dozen Passport (existing ID 9, window=5/target=3), No Duplicates
(existing ID 13, window=target=5), First Return (15), Color Mirror (16), Strict Ascent
(17), Sum Range (18), Final Color Majority (19), Exact Dozen (20).

- First Return includes zero and wins on any later repeat of the first number.
- Color Mirror is RBBR or BRRB, exactly four draws; zero loses.
- Strict Ascent is a<b<c, exactly three draws; zero is 0 and equal numbers lose.
- Sum Range uses targetNumber as inclusive lower and redRatioBps as inclusive upper
  bound, NOT basis points. Exactly three draws; range inside 0..108, excluding the
  guaranteed-win full interval. targetCount=0.
- Final Majority counts selected vs opposite colour over the full window (2..64).
  Zero is neutral, ties lose. It is different from existing first-to-target COLOR_DUEL.
- Exact Dozen counts exactly targetCount (0..window), selected dozen 1..3. Zero excluded.

Only First Return settles early among the six new IDs. All other new rules require the
complete consecutive window even when failure is already mathematically inevitable.
The existing timeout refund policy remains unchanged. Missing rounds cannot be skipped.

## Pricing and activation

`windowCataloguePlan(marketId,minBand,maxBand,houseEdgeBps)` returns all eight candidate
configurations, exact integer sequence counts, compatibility and zero stake limits.
The house edge is an explicit caller input, not a live governance decision. It assumes
independent uniform outcomes. Gross multipliers round down to basis points; token payouts
round down again to asset units. Review fee flows, total exposure and aggregate liquidity.
Never increase odds just to fit a multiplier band. Most proposals do not fit the legacy
5x minimum. No script silently changes that band or enables stake limits.

Activation order: pass CI and storage/bytecode checks; restore healthy roulette processing;
deploy subgraph enum mapping 15–20; deploy compatible frontend; run existing Sepolia
upgrade preflight and authorized SideBet upgrade; verify helper and proxy implementation;
review the generated pricing and the band; add only compatible configs with zero limits;
set reviewed market stake limits separately; place minimal test-token tickets and confirm
receipt, outcome, settlement, balances and reserves for each family. Disable new placement
if verification fails while retaining settlement of existing tickets.

No automatic upgrade, repricing, funding or mainnet activation is performed.
