# Protocol observability upgrade

Source changes do not upgrade live proxies. Deploy libraries and implementation,
validate storage layout against the deployed implementation, and simulate the upgrade
before submitting an authorized governance/admin transaction. Preserve legacy events.

## VRF

`roundDiagnostics` returns the request ID/time, availability flag, both result numbers,
market settlement counters and jackpot payment progress. Pre-upgrade rounds have
`available=false`; read their original events instead of treating missing metadata as
a zero result. `fulfilled=false` means result numbers are not yet usable.
A duplicate fulfillment cannot overwrite randomness or clear a newer pending request.
The callback's existing winner snapshot and admin retry policy are preserved. This change adds no new retry capability.

The local one-market fixture consumes about 249,328 gas for the mock fulfillment
transaction, including mock coordinator overhead. This is not a worst-case certificate.
Callback cost still depends on registered markets and winning bet buckets. Before
increasing market/lane/bet limits, profile the intended maximum and keep headroom in
the VRF callback allowance. Monitor subscription balance separately from wallet LINK.
Escalate delayed fulfillment with its request ID and coordinator transaction history.

## Event parameter layout

Protocol-owned events have no `indexed` parameters, including their duplicate declarations
in linked libraries and the CRE receiver events. All arguments are ABI-encoded in log data;
non-anonymous logs have only the event signature in `topics[0]`. Inherited OpenZeppelin events
and vendored Uniswap contracts keep their original indexed parameters.

Removing `indexed` preserves the event signature hash but changes the topics/data layout.
The regenerated frontend and subgraph ABIs describe the new layout only. Activate them with
the corresponding upgraded/redeployed contracts. Historical indexed logs need their original
ABI and a separate block-bounded indexer/version; do not replay them with the new ABI or mix
both formats under one decoder. Record an exact activation block for every changed contract
or proxy, including replacements for the non-upgradeable funder, TipJar and CRE receivers.
Argument-based topic filters for these protocol events must be replaced with decoded-data
filtering. No live contracts or indexer deployments are changed by regenerating these files.

## Payments

`RoulettePayment` is emitted by delegatecall at the engine address after a successful
vault batch: global round, market, recipient, asset token, amount. Vault transfers are
atomic. Supported assets must follow the existing exact-transfer token assumptions.
`JackpotPayment` identifies a global round, recipient, BRB token and actual amount.
The jackpot is global and must not be assigned to the trigger market as revenue.
Actual jackpot rows follow the canonical treasury's sequential cap semantics.
Any replacement treasury must preserve `brb()` and those payment semantics.

Index explicit receipts separately from legacy Transfer inference, or switch using a
verified activation block. Never add both streams to monetary totals. A transaction
can contain multiple payments to the same wallet: use tx hash + log index as ID.
These events are in linked library ABIs and must be included in indexer ABI exports.

## Withdrawals and funding

`pendingWithdrawalStatus(owner)` exposes a stable ID and queue position; zero ID with
pending=true is a legacy request. Completed receipts retain their timestamps, actual
net payment and burned shares. IDs do not reset when the physical queue is emptied.
No request-time payout guarantee is implied: holdings and vault value can change.

Funding attempt IDs bracket legacy swap/burn/treasury events and expose retained raw
balances. A nonzero retained balance is deferred inventory, not newly earned revenue.
When input is BRB, input balance and BRB balance describe the same tokens: do not sum.
No new sweep, retry, role, or token-routing behavior is introduced. The funder is
non-upgradeable: deploy and deliberately configure a replacement when activating.

## Validation

The regression suite covers exact payout receipts, duplicate VRF callbacks, stable
withdrawal IDs, net transfers, reserve collisions, stale/excess payout bounds,
multi-market jackpot splitting, failed swaps and implementation bytecode size.
Keep the EIP-170 test enabled: local Hardhat allows oversized test harnesses.
