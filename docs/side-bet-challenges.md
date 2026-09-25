# BRBGAME challenge upgrade — testnet activation plan

This is prepared code, not a record of an on-chain upgrade or active markets.
Existing deployment and seeding scripts do not automatically offer these challenges.

## Rules and proposed catalogue

All windows consist of consecutive **global roulette rounds**, not wall-clock seconds.
Only confirmed outcomes count. Missing rounds stop evaluation. Wins may settle early;
the first colour to reach the target decides a duel permanently. A complete window
without the required condition loses. Existing expiry/refund rules are unchanged.

| Enum | Challenge | Window | Condition | Proposed gross multiplier |
| --- | --- | --- | --- | --- |
| 9 | DOZEN_PASSPORT | 5 | Each of the three dozens appears; zero ignored | 1.6004× |
| 10 | BOOMERANG | 6 | Consecutive A–B–A, A different from B; zero included | 9.4008× |
| 11 | MIRROR_PAIR | 5 | Consecutive pair sums to 36, including 18+18 and 0+36 | 9.1518× |
| 12 | WHEEL_NEIGHBORS | 5 | Consecutive outcomes are adjacent on the European wheel, including 26↔0; identical numbers excluded | 4.7664× |
| 13 | DISTINCT_COLLECTION | 6 | At least five distinct numbers, including zero | See generated proposal |
| 14 | COLOR_DUEL | 7 | Selected colour reaches three before the opponent; zero scores nothing; no winner loses | 1.9004× |

`scripts/utils/sideBetChallenges.ts` is the authoritative **proposal**, containing
exact integer winning/total sequence counts. `challengeProbability.ts` computes them
with absorbing-state dynamic programming, assuming independent uniform 0..36 outcomes.
Gross multipliers include returned stake and round down to basis points; actual token
payouts also round down to raw asset units. Counts and short-window closed forms are tested.

Collection succeeds with probability about 95.8192%. A 5% theoretical edge would make
its gross return less than its stake even on success. Its separate proposal uses a 2%
edge instead. This is not applied on-chain and requires economic review with fee flows,
liquidity caps and token-unit rounding before activation. Other proposals use 5%.
Do not increase a multiplier to fit a band: it would change the intended economics.

## Compatibility

Enum indices 0..8 and the SideBet storage struct are unchanged. The new stateless
`SideBetChallengeEvaluator` is created once by each implementation deployment and held
in an immutable. It evaluates both legacy non-jackpot rules (the original library) and
the six additions. Jackpot trigger reads remain in SideBet. There is no mutable helper
admin and no delegatecall into it. Internal helper creation does not consume an extra
transaction nonce from the deployer. Verify both implementation and helper source.

Delegation keeps runtime code under EIP-170. Tests also check both init-code sizes against
EIP-3860. Legacy three-field and V2 four-field settlement APIs remain unchanged. Tests
exercise existing families, each new family's real vault payout, reserve release and
repeat-settlement idempotency. This is not a substitute for an independent contract audit.

## Activation order

1. Pass contract regression CI and compare candidate/proxy storage layout. Run the
   existing read-only upgrade preflight against **Arbitrum Sepolia**, including reserved
   liability reconciliation. Resolve stalled roulette/VRF processing before offering
   additional multi-round bets. Never initialize reserved accounting on a non-empty proxy.
2. Stage and validate the subgraph mapping for indices 9..14 before any new config events.
   Deploy the compatible frontend, which only displays configs actually read from chain.
3. Use the existing guarded SideBet upgrade procedure with the authorized administrator.
   Confirm legacy scheduler settlement still succeeds; verify immutable evaluator code.
4. Read `minMultiplierBps()` and `maxMultiplierBps()` and inspect
   `challengeActivationPlan(min, max)`. At the current default 5× minimum, only Boomerang
   and Mirror proposals fit. Any lower band requires a separate explicit configuration
   decision; the minimum must remain strictly greater than 10000. The upgrade does not
   change this band, existing configs, stakes or payout promises.
5. For each approved market, call `addConfig` with marketId, enum index, selected colour,
   targetNumber=0, redRatioBps=0, the documented window/target, and the approved multiplier.
   Targets: passport=3, collection=5, duel=3, others=0. Initially use zero stake limits.
   Activate through the separate `setConfigStakeLimits` role after liquidity review.
   Price each configured window/target anew; these proposals only price the listed windows.
6. Place a minimal test-token ticket per enabled family. Check SideBetPlaced window,
   consecutive VRF evidence, settlement receipt, player balance, reserves and indexed status.
   Close new configurations if verification fails; keep settlement of existing tickets active.

No owner transaction, multiplier change, deposit, configuration activation or live upgrade
is performed by this change.
