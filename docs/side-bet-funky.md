# Ten funky offers — prepared catalogue

This is source code and a read-only pricing proposal, not an on-chain activation.
`scripts/exportFunkyCatalogue.ts` regenerates `side-bet-funky-pricing.json` for market 1,
the legacy 5–500x band and a proposed 500-bps edge. `funkyCataloguePlan` accepts explicit
market, band and edge inputs. Gross multipliers are floored using exact bigint counts;
token payout rounding needs a reviewed stake floor and limits before activation.

| Offer | Enum | Window | Winning condition |
| --- | --- | --- | --- |
| Chameleon | PERFECT_ALTERNATION (5) | 4 | Alternating colors; zero loses |
| Mirror | COLOR_MIRROR (16) | 4 | RBBR or BRRB; zero loses |
| Déjà vu | ANY_REPEAT (21) | 6 | Any duplicate, even nonadjacent; zero included |
| Escalator | STRICT_ASCENT (17) | 3 | Strictly ascending numbers; zero included |
| Roller coaster | ZIGZAG (22) | 4 | Up/down/up or down/up/down; equal neighbors lose |
| Magnet | ANY_DOZEN (23) | 5 | Any one dozen occurs at least three times; zero ignored |
| Collector | DOZEN_PASSPORT (9) | 5 | All three dozens appear; zero ignored |
| Photo finish | PHOTO_FINISH (24) | 5 | Selected number appears at the final draw only |
| Twins | LIGHTNING_DOUBLE (4) | 6 | Any adjacent identical pair; zero included |
| Eclipse | NUMBER_HIT (1) | 8 | At least one zero |

Déjà vu is different from FIRST_RETURN: the repeated pocket need not be the first.
Magnet is different from DOZEN_HIT: no dozen is selected in advance. Eclipse checks
the roulette number, not the separate jackpot trigger. Photo finish supports pockets
0–36; targetCount and redRatioBps must be zero. ZIGZAG is exactly four draws, with all
unused fields zero. ANY_REPEAT supports 2–16 draws; ANY_DOZEN supports 2–16 draws and
targets 2..window. The bounds keep exact pricing and per-ticket evaluation inexpensive.

Only ANY_REPEAT and ANY_DOZEN can win early among the additions. ZIGZAG and PHOTO_FINISH
settle after the whole consecutive window, even when failure can already be explained.
Missing global rounds are never skipped. Expiry/refund and legacy settlement formats
remain unchanged. IDs 0–20 and all storage structs are unchanged; 21–24 append the enum.
Legacy parameter validation is moved unchanged into the immutable stateless evaluator
to keep SideBet deployable within EIP-170. Tests cover both runtime/init-code limits.

## Activation order

1. Review the linked frontend/subgraph changes and pass contract regression, deployment
   compatibility and storage-layout checks. Run the existing read-only Sepolia preflight.
2. Deploy the subgraph mapping for 21–24 before new config events, then the compatible
   frontend. It displays only actual chain configurations, never the proposal as live offers.
3. Use the existing authorized SideBet upgrade procedure and verify implementation/helper.
   Confirm that existing scheduler settlement still succeeds and roulette processing is healthy.
4. Inspect the actual multiplier band and review the exact pricing proposal. Most frequent
   events do not fit a 5x minimum; never inflate their price to fit the band. A band change
   is a separate governance action, not part of the upgrade or exporter.
5. Add only approved compatible configs with zero stake limits, then separately set reviewed
   limits and token rounding floors after liquidity/exposure review. The exporter never seeds.
6. Verify minimal test-token tickets, exact windows, receipts, payouts and released reserves.
   Retain settlement of existing bets if new placement is disabled.

No owner transaction, mainnet upgrade, funding or configuration activation is performed.
