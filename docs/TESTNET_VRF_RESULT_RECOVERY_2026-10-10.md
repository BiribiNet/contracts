# Sepolia settlement recovery — 2026-10-10

Round 2136 had received VRF randomness (winning number 7, jackpot number 8) and was in Settling. The frontend remained at VRFResult because settlement reverted. This was not a missing VRF callback.

The upgraded Engine calls `queueFunding(uint32,address,uint256)` (selector `0xa062022e`). The active legacy funder `0xfB5075174cb85aDfBf0A4E946840CbFD03bF48a2` did not implement it. A local fork reproduced the exact scheduler job and traced the revert to that funder's dispatch fallback. The fee transfer and settlement rolled back together. The payout workflow exhausted three attempts; its overall Completed label did not mean the round settled. The keeper was approved and funded.

The initial upgrade rehearsal checked idle state and storage but missed settlement compatibility. Future Engine upgrades now reject an active funder without the required selector before deploying libraries. This guard supplements an actual settlement rehearsal; selector presence alone does not establish behavioral compatibility.

## Recovery

A local-fork recovery passed before live execution. The old funder's three asset balances and pending BRB liabilities were zero. Its policy was copied to a new current-version funder, retaining all historical contracts and funds. No VRF retry, wager, old-funder sweep, mainnet transaction or bank replacement was performed.

- New verified funder: `0x16abfab1e1c18c895edce0d6b8125ab451502fd3`.
- Engine wiring: `0x51d0155638708200370b54aaa06836cca5108290be93b63198ae50d91d463a87`.
- Settlement: `0x2556326c61ed4f4e42d60a8f0013ba856e0af1a35cac7184d754c3ff644c73fa`.
- Queued native BRB processing: `0x5fc154330606123a67e4a587ed1bc98a0f337f116571c31e79207cbc40bfd8d4`.

Readback confirmed round 2137 Open, no pending VRF and both payout lanes idle. The 0.03 BRB funding input was processed into 0.025 BRB treasury payment and 0.005 BRB burn, with no remaining queue. SideBet resolves the funder through the Engine, so no separate SideBet address update was needed.

Evidence: `reports/diagnostics/sepolia-round-{before,after}.json`, `sepolia-settlement-trace.json`, and `sepolia-funder-{rehearsal,live}.json`. The recovery script defaults to a local fork; live mode requires chain 421614 and explicit confirmation, with immutable transaction journaling.

## Indexing and operation

The subgraph manifest adds the new funder from block 317694621 and preserves every previous funder source. Goldsky must authenticate project brb (`project_cmfbfxud380il01v04gey3ym6`) before any remote operation. Candidate 0.1.56 is staged separately from the testnet prod alias; promotion requires healthy synchronized indexing and same-block validation.

The recovery processed this native BRB queue once. Continuous funding processing, including non-BRB swaps, still needs an operational keeper and monitoring; the existing payout workflow does not provide that service. Queuing isolates settlement from subsequent funding processing failures.
